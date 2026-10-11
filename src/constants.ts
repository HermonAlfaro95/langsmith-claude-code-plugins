import { COMMON_BOOLEAN_SETTINGS } from "@langchain/plugins-base/settings";

const USER_PROMPT_TURN_NAME = "Claude Code Turn";
const ASSISTANT_RUN_NAME = "Claude";

/** `hooks/hooks.json` is tested against this list. */
const HOOK_EVENT_NAMES = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "StopFailure",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;

/** Only Cursor sends this, so it marks a Cursor payload. */
const CURSOR_VERSION_FIELD = "cursor_version";

/** Cleared before running git so it looks at the session's own folder. */
const GIT_LOCATION_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_CEILING_DIRECTORIES",
];

/** Kept exact since a broken submodule prints a similar error inside a real repo. */
const NOT_A_REPOSITORY = /not a git repository \(or any of the parent directories\)/i;

const TOOL_PATH_INPUT_KEYS = ["file_path", "notebook_path", "path", "cwd"] as const;

const GIT_DIRECTORY_NAME = ".git";

const GIT_MARKERS = {
  REPOSITORY_ROOT: "repository root",
  ONLY_GIT_CAN_SAY: "only git can say",
  NOTHING_HERE: "nothing here",
} as const;

const TURN_REPOSITORY_KEYS = [
  "repository_name",
  "repository_provider",
  "repository_url",
  "git_branch",
  "git_commit_sha",
] as const;

const REPOSITORY_METADATA_KEYS = [...TURN_REPOSITORY_KEYS, "ls_attribution_identifier"] as const;

/** A symbol so it is never serialized and sent to LangSmith. */
const PINNED_REPOSITORY_KEYS = Symbol("pinned repository metadata keys");

const NO_PINNED_KEYS: ReadonlySet<string> = new Set();
const QUEUE_DIR_NAME = "langsmith_queue";
const QUEUE_FILE_SUFFIX = ".queue.json";

/** Replaced so a session id can't escape its folder. */
const QUEUE_SESSION_UNSAFE_CHARS = /[^\w.-]/g;

/** Half-written files use these so readers never see them. */
const QUEUE_TEMP_SUFFIX = ".queue.tmp";

const STATE_TEMP_SUFFIX = ".state.tmp";
const STATE_LOCK_RELEASE_WARNING = "Could not release the shared state lock";
const STATE_LOCK_BUSY_WARNING =
  "Another process holds the state lock, so state updates in this hook are saved for the next lock holder";

const STATE_LOCK_WAIT_MS = 1000;
const STATE_LOCK_PROBE_MS = 200;
const STATE_LOCK_BUSY_MEMORY_MS = 30_000;
const PENDING_STATE_DIR_SUFFIX = ".pending";
const PENDING_STATE_FILE_SUFFIX = ".json";
const PENDING_STATE_TEMP_SUFFIX = ".pending.tmp";
const PENDING_STATE_ABANDONED_MS = 60_000;
const PENDING_STATE_TIME_WIDTH = 13;
const PENDING_STATE_SEQUENCE_WIDTH = 6;
const PENDING_STATE_WRITE_ATTEMPTS = 3;

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Staged then linked so a lock always carries its owner's pid. */
const LOCK_STAGING_SUFFIX = ".lock.staging";

/** Owner-only since these files hold trace content. */
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const QUEUE_ORIGIN_LENGTH = 12;

/** Pads entry names so they sort by time. */
const QUEUE_ID_TIME_WIDTH = 16;

const QUEUE_MAX_ENTRIES = 500;

const QUEUE_MAX_ATTEMPTS = 5;

/** LangSmith rejects a batch holding a run older than this. */
const QUEUE_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Another session's queue is only flushed once this quiet. */
const FOREIGN_QUEUE_MIN_RECORD_AGE_MS = 2 * 60 * 60 * 1000;

const EMPTY_QUEUE_MIN_IDLE_MS = 2 * 60 * 60 * 1000;

const FLUSH_QUEUE_ARG = "--flush-queue";

const GH_LOGIN_COMMAND = "gh";

const GH_LOGIN_ARGUMENTS = ["api", "user", "--jq", ".login"];

const GH_LOGIN_TIMEOUT_MS = 5000;

const GH_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

const JQ_NULL_OUTPUT = "null";

const STATE_FILE_DEFAULT = [".claude", "state", "langsmith_state.json"];

const GH_LOGIN_MARKER_FILE = "langsmith_gh_login.json";

const GH_LOGIN_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const TURN_RECORD_DIR_NAME = "langsmith_turns";
const TURN_RECORD_SUFFIX = ".turn.jsonl";

const TURN_RECORD_MAX_BYTES = 8 * 1024 * 1024;

const REPOSITORY_NAME_KEY = "repository_name";

const ATTRIBUTION_IDENTIFIER_KEY = "ls_attribution_identifier";

const UPDATE_ALREADY_RECEIVED_STATUS = 409;

const RECORDED_RUN_FALLBACK_TYPE = "tool";

const TURN_RECORD_LINE = {
  run: "run",
  closed: "closed",
  delivered: "ok",
  reconciled: "fixed",
} as const;

const BOOLEAN_SETTINGS = {
  enabled: { env: "TRACE_TO_LANGSMITH", ...COMMON_BOOLEAN_SETTINGS.enabled },
  defaultMuted: { env: "CC_LANGSMITH_DEFAULT_MUTED", ...COMMON_BOOLEAN_SETTINGS.defaultMuted },
} as const;

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB

const LOOKUP_TIMEOUT_MS = 4_000;

/** Larger transcripts are streamed instead of read whole. */
const MAX_FULL_READ_BYTES = 50 * 1024 * 1024; // 50 MB

const WORKFLOW_TOOL_NAME = "Workflow";

const WORKFLOW_SUBAGENT_TYPE = "workflow-subagent";

/** A killed subagent never fires SubagentStop, so other statuses count as completed. */
const KILLED_NOTIFICATION_STATUS = "killed";

export {
  BOOLEAN_SETTINGS,
  MAX_LOG_BYTES,
  LOOKUP_TIMEOUT_MS,
  MAX_FULL_READ_BYTES,
  WORKFLOW_TOOL_NAME,
  WORKFLOW_SUBAGENT_TYPE,
  KILLED_NOTIFICATION_STATUS,
  USER_PROMPT_TURN_NAME,
  ASSISTANT_RUN_NAME,
  HOOK_EVENT_NAMES,
  CURSOR_VERSION_FIELD,
  GIT_LOCATION_ENV_KEYS,
  NOT_A_REPOSITORY,
  TOOL_PATH_INPUT_KEYS,
  GIT_DIRECTORY_NAME,
  GIT_MARKERS,
  REPOSITORY_METADATA_KEYS,
  REPOSITORY_NAME_KEY,
  ATTRIBUTION_IDENTIFIER_KEY,
  UPDATE_ALREADY_RECEIVED_STATUS,
  TURN_RECORD_DIR_NAME,
  TURN_RECORD_SUFFIX,
  TURN_RECORD_MAX_BYTES,
  TURN_RECORD_LINE,
  RECORDED_RUN_FALLBACK_TYPE,
  PINNED_REPOSITORY_KEYS,
  NO_PINNED_KEYS,
  GH_LOGIN_COMMAND,
  GH_LOGIN_ARGUMENTS,
  GH_LOGIN_TIMEOUT_MS,
  GH_LOGIN_PATTERN,
  JQ_NULL_OUTPUT,
  STATE_FILE_DEFAULT,
  GH_LOGIN_MARKER_FILE,
  GH_LOGIN_RETRY_AFTER_MS,
  QUEUE_DIR_NAME,
  QUEUE_FILE_SUFFIX,
  QUEUE_SESSION_UNSAFE_CHARS,
  QUEUE_TEMP_SUFFIX,
  STATE_TEMP_SUFFIX,
  STATE_LOCK_RELEASE_WARNING,
  STATE_LOCK_BUSY_WARNING,
  STATE_LOCK_WAIT_MS,
  STATE_LOCK_PROBE_MS,
  STATE_LOCK_BUSY_MEMORY_MS,
  PENDING_STATE_DIR_SUFFIX,
  PENDING_STATE_FILE_SUFFIX,
  PENDING_STATE_TEMP_SUFFIX,
  PENDING_STATE_ABANDONED_MS,
  PENDING_STATE_TIME_WIDTH,
  PENDING_STATE_SEQUENCE_WIDTH,
  PENDING_STATE_WRITE_ATTEMPTS,
  SESSION_MAX_AGE_MS,
  LOCK_STAGING_SUFFIX,
  QUEUE_ID_TIME_WIDTH,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  QUEUE_ORIGIN_LENGTH,
  QUEUE_MAX_ENTRIES,
  QUEUE_MAX_ATTEMPTS,
  QUEUE_RUN_MAX_AGE_MS,
  FOREIGN_QUEUE_MIN_RECORD_AGE_MS,
  EMPTY_QUEUE_MIN_IDLE_MS,
  FLUSH_QUEUE_ARG,
};
