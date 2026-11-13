// The daemon stores each upload at `<PASEO_HOME>/uploads/upload_<uuid>/<file name>`. PASEO_HOME
// varies (`~/.paseo`, a checkout's `.dev/paseo-home`, a custom path), so only the tail is matched.
// The ID has to be the UUID the daemon writes, which keeps a project's own `uploads` folder out.
const UPLOAD_FOLDER_SOURCE =
  "[\\\\/]uploads[\\\\/]upload_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// Each Arena contestant gets `<Global.Path.tmp>/arena/ses_<id>` for saved tool output and scratch
// files; `<Global.Path.tmp>` itself is `<system temp>/opencode`, and a contestant sometimes aims
// at that shared folder. Their shells also export their own directory as `$TMPDIR`, and commands
// quote the variable as often as the path.
const CONTESTANT_TEMP_FOLDER_SOURCE = "[\\\\/]opencode[\\\\/]arena[\\\\/]ses_[A-Za-z0-9]+";
const ENGINE_TEMP_FOLDER_SOURCE = `(?:${CONTESTANT_TEMP_FOLDER_SOURCE}|[\\\\/]T[\\\\/]opencode|[\\\\/]tmp[\\\\/]opencode)(?![\\w.-])`;
const CONTESTANT_TEMP_VARIABLE_SOURCE = "\\$\\{?(?:TMPDIR|TMP|TEMP)\\}?";
const CONTESTANT_TEMP_COMMAND_SOURCE = `(?:${CONTESTANT_TEMP_VARIABLE_SOURCE}|[^\\s"'\`()<>|=,;&]*${ENGINE_TEMP_FOLDER_SOURCE})`;

/** An upload's directory as it appears inside a shell command, for building larger patterns. */
export const UPLOAD_DIRECTORY_IN_COMMAND_SOURCE = `(?:[A-Za-z]:)?[^\\s"'\`()<>|=,;&]*${UPLOAD_FOLDER_SOURCE}`;

/** A contestant's temp directory as it appears inside a shell command, path or `$TMPDIR`. */
export const CONTESTANT_TEMP_DIRECTORY_IN_COMMAND_SOURCE = `(?:[A-Za-z]:)?${CONTESTANT_TEMP_COMMAND_SOURCE}`;

const UPLOAD_DIRECTORY = new RegExp(`^.*${UPLOAD_FOLDER_SOURCE}[\\\\/]*$`, "i");
const UPLOAD_FILE = new RegExp(`^(.*${UPLOAD_FOLDER_SOURCE})[\\\\/]+[^\\\\/]+$`, "i");
const ENGINE_TEMP_DIRECTORY = new RegExp(
  `^(?:${CONTESTANT_TEMP_VARIABLE_SOURCE}|.*${ENGINE_TEMP_FOLDER_SOURCE})(?:[\\\\/].*)?$`,
  "i",
);
const CONTESTANT_TEMP_FILE = new RegExp(`^(.*${ENGINE_TEMP_FOLDER_SOURCE})[\\\\/]+.+$`);

export function isUploadDirectory(path: string): boolean {
  return UPLOAD_DIRECTORY.test(path);
}

export function isContestantTempDirectory(path: string): boolean {
  return ENGINE_TEMP_DIRECTORY.test(path);
}

/** The directory holding an uploaded file, or undefined when the path is not an upload. */
export function uploadDirectoryOf(filePath: string): string | undefined {
  return UPLOAD_FILE.exec(filePath)?.[1];
}

/** The contestant temp directory holding `filePath`, or undefined when outside one. */
export function contestantTempDirectoryOf(filePath: string): string | undefined {
  return CONTESTANT_TEMP_FILE.exec(filePath)?.[1];
}
