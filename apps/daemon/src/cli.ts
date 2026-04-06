const optionToEnv = new Map<string, string>([
  ["server", "NETCHAT_SERVER_URL"],
  ["server-url", "NETCHAT_SERVER_URL"],
  ["machine-name", "NETCHAT_MACHINE_NAME"],
  ["runtime", "NETCHAT_RUNTIME"],
  ["project-cwd", "NETCHAT_RUNTIME_CWD"],
  ["cwd", "NETCHAT_RUNTIME_CWD"],
  ["runtime-cwd", "NETCHAT_RUNTIME_CWD"],
  ["claude-binary", "CLAUDE_BINARY_PATH"],
  ["claude-binary-path", "CLAUDE_BINARY_PATH"],
  ["codex-binary", "CODEX_BINARY_PATH"],
  ["codex-binary-path", "CODEX_BINARY_PATH"],
  ["droid-binary", "DROID_BINARY_PATH"],
  ["droid-binary-path", "DROID_BINARY_PATH"],
]);

export function applyCliEnvOverrides(argv = process.argv.slice(2)) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      printDaemonHelp();
      process.exit(0);
    }

    if (!token.startsWith("--")) {
      continue;
    }

    const [rawName, inlineValue] = token.slice(2).split("=", 2);
    const envKey = optionToEnv.get(rawName);
    if (!envKey) {
      continue;
    }

    const nextValue = inlineValue ?? argv[index + 1];
    if (!nextValue || nextValue.startsWith("--")) {
      throw new Error(`Missing value for --${rawName}`);
    }

    process.env[envKey] = nextValue;
    if (envKey === "NETCHAT_RUNTIME_CWD") {
      process.env.CLAUDE_PROJECT_CWD = nextValue;
    }

    if (!inlineValue) {
      index += 1;
    }
  }
}

function printDaemonHelp() {
  console.log(
    [
      "netchat daemon",
      "",
      "Start the local daemon and connect it to the local server in one command.",
      "",
      "Examples:",
      "  npx @danielwyq/netchat@latest daemon --server http://127.0.0.1:3001",
      "  npx @danielwyq/netchat@latest daemon --server http://127.0.0.1:3001 --machine-name \"My laptop\"",
      "",
      "Options:",
      "  --server, --server-url <url>       NETCHAT_SERVER_URL",
      "  --machine-name <name>              NETCHAT_MACHINE_NAME",
      "  --runtime <kind>                   NETCHAT_RUNTIME (claude|codex|droid|mock)",
      "  --project-cwd, --cwd <path>        NETCHAT_RUNTIME_CWD",
      "  --claude-binary <path>             CLAUDE_BINARY_PATH",
      "  --codex-binary <path>              CODEX_BINARY_PATH",
      "  --droid-binary <path>              DROID_BINARY_PATH",
    ].join("\n"),
  );
}
