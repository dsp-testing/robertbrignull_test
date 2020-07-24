import * as core from '@actions/core';
import fileUrl from 'file-url';
import * as fs from 'fs';
import * as jsonschema from 'jsonschema';
import * as path from 'path';
import zlib from 'zlib';

import * as api from './api-client';
import * as fingerprints from './fingerprints';
import * as sharedEnv from './shared-environment';
import * as util from './util';

// Takes a list of paths to sarif files and combines them together,
// returning the contents of the combined sarif file.
export function combineSarifFiles(sarifFiles: string[]): string {
  let combinedSarif = {
    version: null,
    runs: [] as any[]
  };

  for (let sarifFile of sarifFiles) {
    let sarifObject = JSON.parse(fs.readFileSync(sarifFile, 'utf8'));
    // Check SARIF version
    if (combinedSarif.version === null) {
      combinedSarif.version = sarifObject.version;
    } else if (combinedSarif.version !== sarifObject.version) {
      throw "Different SARIF versions encountered: " + combinedSarif.version + " and " + sarifObject.version;
    }

    combinedSarif.runs.push(...sarifObject.runs);
  }

  return JSON.stringify(combinedSarif);
}

// Upload the given payload.
// If the request fails then this will retry a small number of times.
async function uploadPayload(payload) {
  core.info('Uploading results');

  // If in test mode we don't want to upload the results
  const testMode = process.env['TEST_MODE'] === 'true' || false;
  if (testMode) {
    return;
  }

  const [owner, repo] = util.getRequiredEnvParam("GITHUB_REPOSITORY").split("/");

  // Make up to 4 attempts to upload, and sleep for these
  // number of seconds between each attempt.
  // We don't want to backoff too much to avoid wasting action
  // minutes, but just waiting a little bit could maybe help.
  const backoffPeriods = [1, 5, 15];

  for (let attempt = 0; attempt <= backoffPeriods.length; attempt++) {
    const response = await api.getApiClient().request("PUT /repos/:owner/:repo/code-scanning/analysis", ({
      owner: owner,
      repo: repo,
      data: payload,
    }));

    core.debug('response status: ' + response.status);

    const statusCode = response.status;
    if (statusCode === 202) {
      core.info("Successfully uploaded results");
      return;
    }

    const requestID = response.headers["x-github-request-id"];

    // On any other status code that's not 5xx mark the upload as failed
    if (!statusCode || statusCode < 500 || statusCode >= 600) {
      throw new Error('Upload failed (' + requestID + '): (' + statusCode + ') ' + JSON.stringify(response.data));
    }

    // On a 5xx status code we may retry the request
    if (attempt < backoffPeriods.length) {
      // Log the failure as a warning but don't mark the action as failed yet
      core.warning('Upload attempt (' + (attempt + 1) + ' of ' + (backoffPeriods.length + 1) +
        ') failed (' + requestID + '). Retrying in ' + backoffPeriods[attempt] +
        ' seconds: (' + statusCode + ') ' + JSON.stringify(response.data));
      // Sleep for the backoff period
      await new Promise(r => setTimeout(r, backoffPeriods[attempt] * 1000));
      continue;

    } else {
      // If the upload fails with 5xx then we assume it is a temporary problem
      // and not an error that the user has caused or can fix.
      // We avoid marking the job as failed to avoid breaking CI workflows.
      throw new Error('Upload failed (' + requestID + '): (' + statusCode + ') ' + JSON.stringify(response.data));
    }
  }

  // This case shouldn't ever happen as the final iteration of the loop
  // will always throw an error instead of exiting to here.
  throw new Error('Upload failed');
}

export interface UploadStatusReport {
  // Size in bytes of unzipped SARIF upload
  raw_upload_size_bytes?: number;
  // Size in bytes of actual SARIF upload
  zipped_upload_size_bytes?: number;
  // Number of results in the SARIF upload
  num_results_in_sarif?: number;
}

// Uploads a single sarif file or a directory of sarif files
// depending on what the path happens to refer to.
// Returns true iff the upload occurred and succeeded
export async function upload(input: string): Promise<UploadStatusReport> {
  if (fs.lstatSync(input).isDirectory()) {
    const sarifFiles = fs.readdirSync(input)
      .filter(f => f.endsWith(".sarif"))
      .map(f => path.resolve(input, f));
    if (sarifFiles.length === 0) {
      throw new Error("No SARIF files found to upload in \"" + input + "\".");
    }
    return await uploadFiles(sarifFiles);
  } else {
    return await uploadFiles([input]);
  }
}

// Counts the number of results in the given SARIF file
export function countResultsInSarif(sarif: string): number {
  let numResults = 0;
  for (const run of JSON.parse(sarif).runs) {
    numResults += run.results.length;
  }
  return numResults;
}

// Validates that the given file path refers to a valid SARIF file.
// Throws an error if the file is invalid.
export function validateSarifFileSchema(sarifFilePath: string) {
  const sarif = JSON.parse(fs.readFileSync(sarifFilePath, 'utf8'));
  const schema = JSON.parse(fs.readFileSync(__dirname + '/../src/sarif_v2.1.0_schema.json', 'utf8'));

  const result = new jsonschema.Validator().validate(sarif, schema);
  if (!result.valid) {
    // Output the more verbose error messages in groups as these may be very large.
    for (const error of result.errors) {
      core.startGroup("Error details: " + error.stack);
      core.info(JSON.stringify(error, null, 2));
      core.endGroup();
    }

    // Set the main error message to the stacks of all the errors.
    // This should be of a manageable size and may even give enough to fix the error.
    const sarifErrors = result.errors.map(e => "- " + e.stack);
    throw new Error("Unable to upload \"" + sarifFilePath + "\" as it is not valid SARIF:\n" + sarifErrors.join("\n"));
  }
}

// Uploads the given set of sarif files.
// Returns true iff the upload occurred and succeeded
async function uploadFiles(sarifFiles: string[]): Promise<UploadStatusReport> {
  core.startGroup("Uploading results");
  core.info("Uploading sarif files: " + JSON.stringify(sarifFiles));

  const sentinelEnvVar = "CODEQL_UPLOAD_SARIF";
  if (process.env[sentinelEnvVar]) {
    throw new Error("Aborting upload: only one run of the codeql/analyze or codeql/upload-sarif actions is allowed per job");
  }
  core.exportVariable(sentinelEnvVar, sentinelEnvVar);

  // Validate that the files we were asked to upload are all valid SARIF files
  for (const file of sarifFiles) {
    validateSarifFileSchema(file);
  }

  const commitOid = await util.getCommitOid();
  const workflowRunIDStr = util.getRequiredEnvParam('GITHUB_RUN_ID');
  const ref = util.getRef();
  const analysisKey = await util.getAnalysisKey();
  const analysisName = util.getRequiredEnvParam('GITHUB_WORKFLOW');
  const startedAt = process.env[sharedEnv.CODEQL_WORKFLOW_STARTED_AT];

  let sarifPayload = combineSarifFiles(sarifFiles);
  sarifPayload = fingerprints.addFingerprints(sarifPayload);

  const zipped_sarif = zlib.gzipSync(sarifPayload).toString('base64');
  let checkoutPath = core.getInput('checkout_path');
  let checkoutURI = fileUrl(checkoutPath);
  const workflowRunID = parseInt(workflowRunIDStr, 10);

  if (Number.isNaN(workflowRunID)) {
    throw new Error('GITHUB_RUN_ID must define a non NaN workflow run ID');
  }

  let matrix: string | undefined = core.getInput('matrix');
  if (matrix === "null" || matrix === "") {
    matrix = undefined;
  }

  const toolNames = util.getToolNames(sarifPayload);

  const payload = JSON.stringify({
    "commit_oid": commitOid,
    "ref": ref,
    "analysis_key": analysisKey,
    "analysis_name": analysisName,
    "sarif": zipped_sarif,
    "workflow_run_id": workflowRunID,
    "checkout_uri": checkoutURI,
    "environment": matrix,
    "started_at": startedAt,
    "tool_names": toolNames,
  });

  // Log some useful debug info about the info
  const rawUploadSizeBytes = sarifPayload.length;
  core.debug("Raw upload size: " + rawUploadSizeBytes + " bytes");
  const zippedUploadSizeBytes = zipped_sarif.length;
  core.debug("Base64 zipped upload size: " + zippedUploadSizeBytes + " bytes");
  const numResultInSarif = countResultsInSarif(sarifPayload);
  core.debug("Number of results in upload: " + numResultInSarif);

  // Make the upload
  await uploadPayload(payload);

  core.endGroup();

  return {
    raw_upload_size_bytes: rawUploadSizeBytes,
    zipped_upload_size_bytes: zippedUploadSizeBytes,
    num_results_in_sarif: numResultInSarif,
  };
}
