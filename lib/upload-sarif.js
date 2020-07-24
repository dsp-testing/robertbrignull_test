"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const upload_lib = __importStar(require("./upload-lib"));
const util = __importStar(require("./util"));
async function sendSuccessStatusReport(startedAt, uploadStats) {
    const statusReportBase = await util.createStatusReportBase('upload-sarif', 'success', startedAt);
    const statusReport = {
        ...statusReportBase,
        ...uploadStats,
    };
    await util.sendStatusReport(statusReport);
}
async function run() {
    const startedAt = new Date();
    if (util.should_abort('upload-sarif', false) ||
        !await util.sendStatusReport(await util.createStatusReportBase('upload-sarif', 'starting', startedAt), true)) {
        return;
    }
    try {
        const uploadStats = await upload_lib.upload(core.getInput('sarif_file'));
        await sendSuccessStatusReport(startedAt, uploadStats);
    }
    catch (error) {
        core.setFailed(error.message);
        await util.sendStatusReport(await util.createStatusReportBase('upload-sarif', 'failure', startedAt, error.message, error.stack));
        return;
    }
}
run().catch(e => {
    core.setFailed("codeql/upload-sarif action failed: " + e);
    console.log(e);
});
//# sourceMappingURL=upload-sarif.js.map