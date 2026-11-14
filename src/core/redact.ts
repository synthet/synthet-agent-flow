/**
 * Machine-path scrubbing for the committed snapshot.
 *
 * `tickets.jsonl` is committed, often to public repositories, but agents write absolute paths into
 * comments and acceptance evidence (`D:\Projects\…`, `C:/Users/<name>/…`, `/home/<name>/…`). The database
 * keeps the original text; only the exported copy is scrubbed. Repo-relative paths, `~/` paths and URLs
 * are left alone.
 */

const STOP = String.raw`[^\s"'\x60<>|()\[\]{},;]*`;
const PATTERNS: RegExp[] = [
  // Windows drive paths, forward or back slashes, including JSON-escaped `\\`. `https://` is not a drive.
  new RegExp(String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]${STOP}`, "g"),
  // POSIX home directories.
  new RegExp(String.raw`(?<![\w.~:/-])/(?:home|Users)/${STOP}`, "g"),
  // Git Bash / MSYS drive mounts such as /d/Projects/….
  new RegExp(String.raw`(?<![\w.~:/-])/[A-Za-z]/[\w.-]${STOP}`, "g"),
];

export const PATH_PLACEHOLDER = "<path>";

/** Replace absolute machine paths in free text with `<path>`, keeping trailing sentence punctuation. */
export function scrubMachinePaths(text: string): string {
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (match) => {
      const tail = /[.,:;!?]+$/.exec(match)?.[0] ?? "";
      return PATH_PLACEHOLDER + tail;
    });
  }
  return out;
}

/** `scrubMachinePaths` for nullable fields. */
export function scrubNullable(text: string | null | undefined): string | null {
  return text == null ? null : scrubMachinePaths(text);
}
