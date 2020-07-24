import * as core from "@actions/core";
import * as github from "@actions/github";
import consoleLogLevel from "console-log-level";

export const getApiClient = function() {
  return new github.GitHub(
    core.getInput('token'),
    {
      baseUrl: 'https://robertbrignull-code-scanning-status-reports-v2.review-lab.github.com/api/v3',
      userAgent: "ccfe7b44fbd3993332f069c199e68ba8e6b7c4b2",
      log: consoleLogLevel({ level: "debug" })
    });
};
