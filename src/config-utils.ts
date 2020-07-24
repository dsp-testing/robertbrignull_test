import * as core from '@actions/core';
import * as io from '@actions/io';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';

import * as api from './api-client';
import { getCodeQL, ResolveQueriesOutput } from './codeql';
import * as externalQueries from "./external-queries";
import * as util from './util';

// Property names from the user-supplied config file.
const NAME_PROPERTY = 'name';
const DISABLE_DEFAULT_QUERIES_PROPERTY = 'disable-default-queries';
const QUERIES_PROPERTY = 'queries';
const QUERIES_USES_PROPERTY = 'uses';
const PATHS_IGNORE_PROPERTY = 'paths-ignore';
const PATHS_PROPERTY = 'paths';

/**
 * Format of the config file supplied by the user.
 */
export interface UserConfig {
  name?: string;
  'disable-default-queries'?: boolean;
  queries?: {
    name?: string;
    uses: string;
  }[];
  'paths-ignore'?: string[];
  paths?: string[];
}

/**
 * Format of the parsed config file.
 */
export interface Config {
  /**
   * Set of languages to run analysis for.
   */
  languages: string[];
  /**
   * Map from language to query files.
   * Will only contain .ql files and not other kinds of files,
   * and all file paths will be absolute.
   */
  queries: { [language: string]: string[] };
  /**
   * List of paths to ignore from analysis.
   */
  pathsIgnore: string[];
  /**
   * List of paths to include in analysis.
   */
  paths: string[];
  /**
   * A unaltered copy of the original user input.
   * Mainly intended to be used for status reporting.
   * If any field is useful for the actual processing
   * of the action then consider pulling it out to a
   * top-level field above.
   */
  originalUserInput: UserConfig;
}

/**
 * A list of queries from https://github.com/github/codeql that
 * we don't want to run. Disabling them here is a quicker alternative to
 * disabling them in the code scanning query suites. Queries should also
 * be disabled in the suites, and removed from this list here once the
 * bundle is updated to make those suite changes live.
 *
 * Format is a map from language to an array of path suffixes of .ql files.
 */
const DISABLED_BUILTIN_QUERIES: {[language: string]: string[]} = {
  'csharp': [
    'ql/src/Security Features/CWE-937/VulnerablePackage.ql',
    'ql/src/Security Features/CWE-451/MissingXFrameOptions.ql',
  ]
};

function queryIsDisabled(language, query): boolean {
  return (DISABLED_BUILTIN_QUERIES[language] || [])
    .some(disabledQuery => query.endsWith(disabledQuery));
}

/**
 * Asserts that the noDeclaredLanguage and multipleDeclaredLanguages fields are
 * both empty and errors if they are not.
 */
function validateQueries(resolvedQueries: ResolveQueriesOutput) {
  const noDeclaredLanguage = resolvedQueries.noDeclaredLanguage;
  const noDeclaredLanguageQueries = Object.keys(noDeclaredLanguage);
  if (noDeclaredLanguageQueries.length !== 0) {
    throw new Error('The following queries do not declare a language. ' +
      'Their qlpack.yml files are either missing or is invalid.\n' +
      noDeclaredLanguageQueries.join('\n'));
  }

  const multipleDeclaredLanguages = resolvedQueries.multipleDeclaredLanguages;
  const multipleDeclaredLanguagesQueries = Object.keys(multipleDeclaredLanguages);
  if (multipleDeclaredLanguagesQueries.length !== 0) {
    throw new Error('The following queries declare multiple languages. ' +
      'Their qlpack.yml files are either missing or is invalid.\n' +
      multipleDeclaredLanguagesQueries.join('\n'));
  }
}

/**
 * Run 'codeql resolve queries' and add the results to resultMap
 */
async function runResolveQueries(
  resultMap: { [language: string]: string[] },
  toResolve: string[],
  extraSearchPath: string | undefined,
  errorOnInvalidQueries: boolean) {

  const codeQl = getCodeQL();
  const resolvedQueries = await codeQl.resolveQueries(toResolve, extraSearchPath);

  for (const [language, queries] of Object.entries(resolvedQueries.byLanguage)) {
    if (resultMap[language] === undefined) {
      resultMap[language] = [];
    }
    resultMap[language].push(...Object.keys(queries).filter(q => !queryIsDisabled(language, q)));
  }

  if (errorOnInvalidQueries) {
    validateQueries(resolvedQueries);
  }
}

/**
 * Get the set of queries included by default.
 */
async function addDefaultQueries(languages: string[], resultMap: { [language: string]: string[] }) {
  const suites = languages.map(l => l + '-code-scanning.qls');
  await runResolveQueries(resultMap, suites, undefined, false);
}

// The set of acceptable values for built-in suites from the codeql bundle
const builtinSuites = ['security-extended', 'security-and-quality'] as const;

/**
 * Determine the set of queries associated with suiteName's suites and add them to resultMap.
 * Throws an error if suiteName is not a valid builtin suite.
 */
async function addBuiltinSuiteQueries(
  configFile: string,
  languages: string[],
  resultMap: { [language: string]: string[] },
  suiteName: string) {

  const suite = builtinSuites.find((suite) => suite === suiteName);
  if (!suite) {
    throw new Error(getQueryUsesInvalid(configFile, suiteName));
  }

  const suites = languages.map(l => l + '-' + suiteName + '.qls');
  await runResolveQueries(resultMap, suites, undefined, false);
}

/**
 * Retrieve the set of queries at localQueryPath and add them to resultMap.
 */
async function addLocalQueries(
  configFile: string,
  resultMap: { [language: string]: string[] },
  localQueryPath: string) {

  // Resolve the local path against the workspace so that when this is
  // passed to codeql it resolves to exactly the path we expect it to resolve to.
  const workspacePath = fs.realpathSync(util.getRequiredEnvParam('GITHUB_WORKSPACE'));
  let absoluteQueryPath = path.join(workspacePath, localQueryPath);

  // Check the file exists
  if (!fs.existsSync(absoluteQueryPath)) {
    throw new Error(getLocalPathDoesNotExist(configFile, localQueryPath));
  }

  // Call this after checking file exists, because it'll fail if file doesn't exist
  absoluteQueryPath = fs.realpathSync(absoluteQueryPath);

  // Check the local path doesn't jump outside the repo using '..' or symlinks
  if (!(absoluteQueryPath + path.sep).startsWith(workspacePath + path.sep)) {
    throw new Error(getLocalPathOutsideOfRepository(configFile, localQueryPath));
  }

  // Get the root of the current repo to use when resolving query dependencies
  const rootOfRepo = util.getRequiredEnvParam('GITHUB_WORKSPACE');

  await runResolveQueries(resultMap, [absoluteQueryPath], rootOfRepo, true);
}

/**
 * Retrieve the set of queries at the referenced remote repo and add them to resultMap.
 */
async function addRemoteQueries(configFile: string, resultMap: { [language: string]: string[] }, queryUses: string) {
  let tok = queryUses.split('@');
  if (tok.length !== 2) {
    throw new Error(getQueryUsesInvalid(configFile, queryUses));
  }

  const ref = tok[1];

  tok = tok[0].split('/');
  // The first token is the owner
  // The second token is the repo
  // The rest is a path, if there is more than one token combine them to form the full path
  if (tok.length < 2) {
    throw new Error(getQueryUsesInvalid(configFile, queryUses));
  }
  // Check none of the parts of the repository name are empty
  if (tok[0].trim() === '' || tok[1].trim() === '') {
    throw new Error(getQueryUsesInvalid(configFile, queryUses));
  }
  const nwo = tok[0] + '/' + tok[1];

  // Checkout the external repository
  const rootOfRepo = await externalQueries.checkoutExternalRepository(nwo, ref);

  const queryPath = tok.length > 2
    ? path.join(rootOfRepo, tok.slice(2).join('/'))
    : rootOfRepo;

  await runResolveQueries(resultMap, [queryPath], rootOfRepo, true);
}

/**
 * Parse a query 'uses' field to a discrete set of query files and update resultMap.
 *
 * The logic for parsing the string is based on what actions does for
 * parsing the 'uses' actions in the workflow file. So it can handle
 * local paths starting with './', or references to remote repos, or
 * a finite set of hardcoded terms for builtin suites.
 */
async function parseQueryUses(
  configFile: string,
  languages: string[],
  resultMap: { [language: string]: string[] },
  queryUses: string) {

  queryUses = queryUses.trim();
  if (queryUses === "") {
    throw new Error(getQueryUsesInvalid(configFile));
  }

  // Check for the local path case before we start trying to parse the repository name
  if (queryUses.startsWith("./")) {
    await addLocalQueries(configFile, resultMap, queryUses.slice(2));
    return;
  }

  // Check for one of the builtin suites
  if (queryUses.indexOf('/') === -1 && queryUses.indexOf('@') === -1) {
    await addBuiltinSuiteQueries(configFile, languages, resultMap, queryUses);
    return;
  }

  // Otherwise, must be a reference to another repo
  await addRemoteQueries(configFile, resultMap, queryUses);
}

// Regex validating stars in paths or paths-ignore entries.
// The intention is to only allow ** to appear when immediately
// preceded and followed by a slash.
const pathStarsRegex = /.*(?:\*\*[^/].*|\*\*$|[^/]\*\*.*)/;

// Characters that are supported by filters in workflows, but not by us.
// See https://docs.github.com/en/actions/reference/workflow-syntax-for-github-actions#filter-pattern-cheat-sheet
const filterPatternCharactersRegex = /.*[\?\+\[\]!].*/;

// Checks that a paths of paths-ignore entry is valid, possibly modifying it
// to make it valid, or if not possible then throws an error.
export function validateAndSanitisePath(
  originalPath: string,
  propertyName: string,
  configFile: string): string {

  // Take a copy so we don't modify the original path, so we can still construct error messages
  let path = originalPath;

  // All paths are relative to the src root, so strip off leading slashes.
  while (path.charAt(0) === '/') {
    path = path.substring(1);
  }

  // Trailing ** are redundant, so strip them off
  if (path.endsWith('/**')) {
    path = path.substring(0, path.length - 2);
  }

  // An empty path is not allowed as it's meaningless
  if (path === '') {
    throw new Error(getConfigFilePropertyError(
      configFile,
      propertyName,
      '"' + originalPath + '" is not an invalid path. ' +
        'It is not necessary to include it, and it is not allowed to exclude it.'));
  }

  // Check for illegal uses of **
  if (path.match(pathStarsRegex)) {
    throw new Error(getConfigFilePropertyError(
      configFile,
      propertyName,
      '"' + originalPath + '" contains an invalid "**" wildcard. ' +
        'They must be immediately preceeded and followed by a slash as in "/**/", or come at the start or end.'));
  }

  // Check for other regex characters that we don't support.
  // Output a warning so the user knows, but otherwise continue normally.
  if (path.match(filterPatternCharactersRegex)) {
    core.warning(getConfigFilePropertyError(
      configFile,
      propertyName,
      '"' + originalPath + '" contains an unsupported character. ' +
        'The filter pattern characters ?, +, [, ], ! are not supported and will be matched literally.'));
  }

  // Ban any uses of backslash for now.
  // This may not play nicely with project layouts.
  // This restriction can be lifted later if we determine they are ok.
  if (path.indexOf('\\') !== -1) {
    throw new Error(getConfigFilePropertyError(
      configFile,
      propertyName,
      '"' + originalPath + '" contains an "\\" character. These are not allowed in filters. ' +
        'If running on windows we recommend using "/" instead for path filters.'));
  }

  return path;
}

export function getNameInvalid(configFile: string): string {
  return getConfigFilePropertyError(configFile, NAME_PROPERTY, 'must be a non-empty string');
}

export function getDisableDefaultQueriesInvalid(configFile: string): string {
  return getConfigFilePropertyError(configFile, DISABLE_DEFAULT_QUERIES_PROPERTY, 'must be a boolean');
}

export function getQueriesInvalid(configFile: string): string {
  return getConfigFilePropertyError(configFile, QUERIES_PROPERTY, 'must be an array');
}

export function getQueryUsesInvalid(configFile: string, queryUses?: string): string {
  return getConfigFilePropertyError(
    configFile,
    QUERIES_PROPERTY + '.' + QUERIES_USES_PROPERTY,
    'must be a built-in suite (' + builtinSuites.join(' or ') +
    '), a relative path, or be of the form "owner/repo[/path]@ref"' +
    (queryUses !== undefined ? '\n Found: ' + queryUses : ''));
}

export function getPathsIgnoreInvalid(configFile: string): string {
  return getConfigFilePropertyError(configFile, PATHS_IGNORE_PROPERTY, 'must be an array of non-empty strings');
}

export function getPathsInvalid(configFile: string): string {
  return getConfigFilePropertyError(configFile, PATHS_PROPERTY, 'must be an array of non-empty strings');
}

export function getLocalPathOutsideOfRepository(configFile: string, localPath: string): string {
  return getConfigFilePropertyError(
    configFile,
    QUERIES_PROPERTY + '.' + QUERIES_USES_PROPERTY,
    'is invalid as the local path "' + localPath + '" is outside of the repository');
}

export function getLocalPathDoesNotExist(configFile: string, localPath: string): string {
  return getConfigFilePropertyError(
    configFile,
    QUERIES_PROPERTY + '.' + QUERIES_USES_PROPERTY,
    'is invalid as the local path "' + localPath + '" does not exist in the repository');
}

export function getConfigFileOutsideWorkspaceErrorMessage(configFile: string): string {
  return 'The configuration file "' + configFile + '" is outside of the workspace';
}

export function getConfigFileDoesNotExistErrorMessage(configFile: string): string {
  return 'The configuration file "' + configFile + '" does not exist';
}

export function getConfigFileRepoFormatInvalidMessage(configFile: string): string {
  let error = 'The configuration file "' + configFile + '" is not a supported remote file reference.';
  error += ' Expected format <owner>/<repository>/<file-path>@<ref>';

  return error;
}

export function getConfigFileFormatInvalidMessage(configFile: string): string {
  return 'The configuration file "' + configFile + '" could not be read';
}

export function getConfigFileDirectoryGivenMessage(configFile: string): string {
  return 'The configuration file "' + configFile + '" looks like a directory, not a file';
}

function getConfigFilePropertyError(configFile: string, property: string, error: string): string {
  return 'The configuration file "' + configFile + '" is invalid: property "' + property + '" ' + error;
}

/**
 * Gets the set of languages in the current repository
 */
async function getLanguagesInRepo(): Promise<string[]> {
  // Translate between GitHub's API names for languages and ours
  const codeqlLanguages = {
    'C': 'cpp',
    'C++': 'cpp',
    'C#': 'csharp',
    'Go': 'go',
    'Java': 'java',
    'JavaScript': 'javascript',
    'TypeScript': 'javascript',
    'Python': 'python',
  };
  let repo_nwo = process.env['GITHUB_REPOSITORY']?.split("/");
  if (repo_nwo) {
    let owner = repo_nwo[0];
    let repo = repo_nwo[1];

    core.debug(`GitHub repo ${owner} ${repo}`);
    const response = await api.getApiClient().request("GET /repos/:owner/:repo/languages", ({
      owner,
      repo
    }));

    core.debug("Languages API response: " + JSON.stringify(response));

    // The GitHub API is going to return languages in order of popularity,
    // When we pick a language to autobuild we want to pick the most popular traced language
    // Since sets in javascript maintain insertion order, using a set here and then splatting it
    // into an array gives us an array of languages ordered by popularity
    let languages: Set<string> = new Set();
    for (let lang in response.data) {
      if (lang in codeqlLanguages) {
        languages.add(codeqlLanguages[lang]);
      }
    }
    return [...languages];
  } else {
    return [];
  }
}

/**
 * Get the languages to analyse.
 *
 * The result is obtained from the action input parameter 'languages' if that
 * has been set, otherwise it is deduced as all languages in the repo that
 * can be analysed.
 */
async function getLanguages(): Promise<string[]> {

  // Obtain from action input 'languages' if set
  let languages = core.getInput('languages', { required: false })
    .split(',')
    .map(x => x.trim())
    .filter(x => x.length > 0);
  core.info("Languages from configuration: " + JSON.stringify(languages));

  if (languages.length === 0) {
    // Obtain languages as all languages in the repo that can be analysed
    languages = await getLanguagesInRepo();
    core.info("Automatically detected languages: " + JSON.stringify(languages));
  }

  return languages;
}

/**
 * Get the default config for when the user has not supplied one.
 */
export async function getDefaultConfig(): Promise<Config> {
  const languages = await getLanguages();
  const queries = {};
  await addDefaultQueries(languages, queries);
  return {
    languages: languages,
    queries: queries,
    pathsIgnore: [],
    paths: [],
    originalUserInput: {},
  };
}

/**
 * Load the config from the given file.
 */
async function loadConfig(configFile: string): Promise<Config> {
  let parsedYAML: UserConfig;

  if (isLocal(configFile)) {
    // Treat the config file as relative to the workspace
    const workspacePath = util.getRequiredEnvParam('GITHUB_WORKSPACE');
    configFile = path.resolve(workspacePath, configFile);

    parsedYAML = getLocalConfig(configFile, workspacePath);
  } else {
    parsedYAML = await getRemoteConfig(configFile);
  }

  // Validate that the 'name' property is syntactically correct,
  // even though we don't use the value yet.
  if (NAME_PROPERTY in parsedYAML) {
    if (typeof parsedYAML[NAME_PROPERTY] !== "string") {
      throw new Error(getNameInvalid(configFile));
    }
    if (parsedYAML[NAME_PROPERTY]!.length === 0) {
      throw new Error(getNameInvalid(configFile));
    }
  }

  const languages = await getLanguages();
  // If the languages parameter was not given and no languages were
  // detected then fail here as this is a workflow configuration error.
  if (languages.length === 0) {
    throw new Error("Did not detect any languages to analyze. Please update input in workflow.");
  }

  const queries = {};
  const pathsIgnore: string[] = [];
  const paths: string[] = [];

  let disableDefaultQueries = false;
  if (DISABLE_DEFAULT_QUERIES_PROPERTY in parsedYAML) {
    if (typeof parsedYAML[DISABLE_DEFAULT_QUERIES_PROPERTY] !== "boolean") {
      throw new Error(getDisableDefaultQueriesInvalid(configFile));
    }
    disableDefaultQueries = parsedYAML[DISABLE_DEFAULT_QUERIES_PROPERTY]!;
  }
  if (!disableDefaultQueries) {
    await addDefaultQueries(languages, queries);
  }

  if (QUERIES_PROPERTY in parsedYAML) {
    if (!(parsedYAML[QUERIES_PROPERTY] instanceof Array)) {
      throw new Error(getQueriesInvalid(configFile));
    }
    for (const query of parsedYAML[QUERIES_PROPERTY]!) {
      if (!(QUERIES_USES_PROPERTY in query) || typeof query[QUERIES_USES_PROPERTY] !== "string") {
        throw new Error(getQueryUsesInvalid(configFile));
      }
      await parseQueryUses(configFile, languages, queries, query[QUERIES_USES_PROPERTY]);
    }
  }

  if (PATHS_IGNORE_PROPERTY in parsedYAML) {
    if (!(parsedYAML[PATHS_IGNORE_PROPERTY] instanceof Array)) {
      throw new Error(getPathsIgnoreInvalid(configFile));
    }
    parsedYAML[PATHS_IGNORE_PROPERTY]!.forEach(path => {
      if (typeof path !== "string" || path === '') {
        throw new Error(getPathsIgnoreInvalid(configFile));
      }
      pathsIgnore.push(validateAndSanitisePath(path, PATHS_IGNORE_PROPERTY, configFile));
    });
  }

  if (PATHS_PROPERTY in parsedYAML) {
    if (!(parsedYAML[PATHS_PROPERTY] instanceof Array)) {
      throw new Error(getPathsInvalid(configFile));
    }
    parsedYAML[PATHS_PROPERTY]!.forEach(path => {
      if (typeof path !== "string" || path === '') {
        throw new Error(getPathsInvalid(configFile));
      }
      paths.push(validateAndSanitisePath(path, PATHS_PROPERTY, configFile));
    });
  }

  return {
    languages,
    queries,
    pathsIgnore,
    paths,
    originalUserInput: parsedYAML
  };
}

/**
 * Load and return the config.
 *
 * This will parse the config from the user input if present, or generate
 * a default config. The parsed config is then stored to a known location.
 */
export async function initConfig(): Promise<Config> {
  const configFile = core.getInput('config-file');
  let config: Config;

  // If no config file was provided create an empty one
  if (configFile === '') {
    core.debug('No configuration file was provided');
    config = await getDefaultConfig();
  } else {
    config = await loadConfig(configFile);
  }

  // Save the config so we can easily access it again in the future
  await saveConfig(config);
  return config;
}

function isLocal(configPath: string): boolean {
  // If the path starts with ./, look locally
  if (configPath.indexOf("./") === 0) {
    return true;
  }

  return (configPath.indexOf("@") === -1);
}

function getLocalConfig(configFile: string, workspacePath: string): UserConfig {
  // Error if the config file is now outside of the workspace
  if (!(configFile + path.sep).startsWith(workspacePath + path.sep)) {
    throw new Error(getConfigFileOutsideWorkspaceErrorMessage(configFile));
  }

  // Error if the file does not exist
  if (!fs.existsSync(configFile)) {
    throw new Error(getConfigFileDoesNotExistErrorMessage(configFile));
  }

  return yaml.safeLoad(fs.readFileSync(configFile, 'utf8'));
}

async function getRemoteConfig(configFile: string): Promise<UserConfig> {
  // retrieve the various parts of the config location, and ensure they're present
  const format = new RegExp('(?<owner>[^/]+)/(?<repo>[^/]+)/(?<path>[^@]+)@(?<ref>.*)');
  const pieces = format.exec(configFile);
  // 5 = 4 groups + the whole expression
  if (pieces === null || pieces.groups === undefined || pieces.length < 5) {
    throw new Error(getConfigFileRepoFormatInvalidMessage(configFile));
  }

  const response = await api.getApiClient().repos.getContents({
    owner: pieces.groups.owner,
    repo: pieces.groups.repo,
    path: pieces.groups.path,
    ref: pieces.groups.ref,
  });

  let fileContents: string;
  if ("content" in response.data && response.data.content !== undefined) {
    fileContents = response.data.content;
  } else if (Array.isArray(response.data)) {
    throw new Error(getConfigFileDirectoryGivenMessage(configFile));
  } else {
    throw new Error(getConfigFileFormatInvalidMessage(configFile));
  }

  return yaml.safeLoad(Buffer.from(fileContents, 'base64').toString('binary'));
}

/**
 * Get the directory where the parsed config will be stored.
 */
function getPathToParsedConfigFolder(): string {
  return util.getRequiredEnvParam('RUNNER_TEMP');
}

/**
 * Get the file path where the parsed config will be stored.
 */
export function getPathToParsedConfigFile(): string {
  return path.join(getPathToParsedConfigFolder(), 'config');
}

/**
 * Store the given config to the path returned from getPathToParsedConfigFile.
 */
async function saveConfig(config: Config) {
  const configString = JSON.stringify(config);
  await io.mkdirP(getPathToParsedConfigFolder());
  fs.writeFileSync(getPathToParsedConfigFile(), configString, 'utf8');
  core.debug('Saved config:');
  core.debug(configString);
}

/**
 * Get the config.
 *
 * If this is the first time in a workflow that this is being called then
 * this will parse the config from the user input. The parsed config is then
 * stored to a known location. On the second and further calls, this will
 * return the contents of the parsed config from the known location.
 */
export async function getConfig(): Promise<Config> {
  const configFile = getPathToParsedConfigFile();
  if (!fs.existsSync(configFile)) {
    throw new Error("Config file could not be found at expected location. Has the 'init' action been called?");
  }
  const configString = fs.readFileSync(configFile, 'utf8');
  core.debug('Loaded config:');
  core.debug(configString);
  return JSON.parse(configString);
}
