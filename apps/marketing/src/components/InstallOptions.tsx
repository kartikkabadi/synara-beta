// FILE: InstallOptions.tsx
// Purpose: Renders the three platform download cards (macOS / Windows / Linux),
//          detects the visitor's OS to highlight the recommended one, and lets
//          Mac users switch between the Apple Silicon and Intel builds.
// Layer: Client component
// Depends on: src/lib/platform, src/lib/releases (ReleaseDownloads type), InstallerCount

"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { FaApple, FaWindows, FaLinux } from "react-icons/fa";
import { LuArrowDownToLine, LuCheck, LuTerminal } from "react-icons/lu";
import InstallerCount from "@/components/InstallerCount";
import { detectCurrentOS, detectMacArch, type MacArch, type OS } from "@/lib/platform";
import type { ReleaseDownloads } from "@/lib/releases";

const OS_LABEL: Record<Exclude<OS, "unknown">, string> = {
  mac: "macOS",
  windows: "Windows",
  linux: "Linux",
};

// Detection is a one-time, client-only browser read, so we expose it through
// useSyncExternalStore (like DownloadButton) instead of a setState-in-effect.
// Results are memoized at module scope so the WebGL probe runs at most once.
const subscribe = () => () => {};

let cachedOS: OS | undefined;
function getOSSnapshot(): OS {
  if (cachedOS === undefined) cachedOS = detectCurrentOS();
  return cachedOS;
}

let cachedArch: MacArch | undefined;
function getArchSnapshot(): MacArch {
  if (cachedArch === undefined) cachedArch = detectMacArch();
  return cachedArch;
}

export default function InstallOptions({
  downloads,
  installerCount,
}: {
  downloads: ReleaseDownloads;
  installerCount: number | null;
}) {
  // "unknown"/"arm64" during SSR + first client render, then the real values.
  const os = useSyncExternalStore<OS>(subscribe, getOSSnapshot, () => "unknown");
  const detectedArch = useSyncExternalStore(subscribe, getArchSnapshot, () => "arm64" as MacArch);

  // User can override the detected Mac architecture via the toggle.
  const [archOverride, setArchOverride] = useState<MacArch | null>(null);
  const arch = archOverride ?? detectedArch;

  // Linux AppImages ship for x86_64 and arm64; default to x86_64 (the
  // overwhelming majority of Linux desktops) and let the toggle switch.
  const [linuxArchOverride, setLinuxArchOverride] = useState<MacArch | null>(null);
  const linuxArch = linuxArchOverride ?? "x64";

  const macHref = arch === "arm64" ? downloads.mac.arm64 : downloads.mac.x64;
  const linuxHref = linuxArch === "arm64" ? downloads.linux.arm64 : downloads.linux.x64;

  return (
    <div className="flex flex-col items-center text-center">
      <p className="mb-6 min-h-[18px] text-[12px] text-[var(--text-tertiary)]">
        {os !== "unknown" ? (
          <>
            Detected <span className="text-[var(--text-secondary)]">{OS_LABEL[os]}</span> —
            recommended option highlighted below.
          </>
        ) : (
          "Pick your platform to download the latest build."
        )}
      </p>

      <div className="grid w-full gap-4 sm:grid-cols-3">
        <PlatformCard
          index={0}
          icon={<FaApple className="size-6" aria-hidden="true" />}
          name="macOS"
          subtitle=".dmg · Apple Silicon & Intel"
          href={macHref}
          recommended={os === "mac"}
        >
          <ArchToggle
            ariaLabel="macOS chip"
            options={ARCH_OPTIONS}
            value={arch}
            onChange={setArchOverride}
          />
        </PlatformCard>

        <PlatformCard
          index={1}
          icon={<FaWindows className="size-[22px]" aria-hidden="true" />}
          name="Windows"
          subtitle=".exe installer · 64-bit"
          href={downloads.windows}
          recommended={os === "windows"}
        />

        <PlatformCard
          index={2}
          icon={<FaLinux className="size-6" aria-hidden="true" />}
          name="Linux"
          subtitle=".AppImage · x86_64 & arm64"
          href={linuxHref}
          recommended={os === "linux"}
        >
          <ArchToggle
            ariaLabel="Linux architecture"
            options={LINUX_ARCH_OPTIONS}
            value={linuxArch}
            onChange={setLinuxArchOverride}
          />
        </PlatformCard>
      </div>

      <TerminalInstall />

      <p className="mt-8 text-[12px] text-[var(--text-tertiary)]">
        <InstallerCount initialCount={installerCount} />
      </p>

      <p className="mt-2 text-[12px] leading-[1.6] text-[var(--text-tertiary)]">
        {downloads.version ? `Latest release ${downloads.version}. ` : ""}
        Looking for an older version or the checksums?{" "}
        <a
          href={downloads.releasesUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--accent-link)] underline decoration-[var(--accent-link)] underline-offset-2 transition-colors hover:text-[var(--accent-link-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
        >
          Browse all releases
        </a>
        .
      </p>
    </div>
  );
}

const TERMINAL_INSTALL_COMMANDS: ReadonlyArray<{ os: string; command: string }> = [
  {
    os: "macOS",
    command:
      't=$(curl -fsSL "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" | grep \'"tag_name"\' | sed -n \'s/.*"tag_name":[[:space:]]*"\\([^"]*\\)".*/\\1/p\' | grep -E \'^v[0-9]+\\.[0-9]+\\.[0-9]+-beta\\.[0-9]+$\' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Synara Beta release." >&2; (exit 1); else f=$(mktemp /tmp/synara-beta-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-macos.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/synara-beta-install-none}"; (exit $rc); fi',
  },
  {
    os: "Linux",
    command:
      't=$(curl -fsSL "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" | grep \'"tag_name"\' | sed -n \'s/.*"tag_name":[[:space:]]*"\\([^"]*\\)".*/\\1/p\' | grep -E \'^v[0-9]+\\.[0-9]+\\.[0-9]+-beta\\.[0-9]+$\' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Synara Beta release." >&2; (exit 1); else f=$(mktemp /tmp/synara-beta-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-linux.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/synara-beta-install-none}"; (exit $rc); fi',
  },
  {
    os: "Windows (PowerShell)",
    command:
      '$t = ((Invoke-RestMethod "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" -UseBasicParsing -ErrorAction Stop) | Where-Object { $_.tag_name -match \'^v\\d+\\.\\d+\\.\\d+-beta\\.\\d+$\' } | Select-Object -First 1).tag_name; if ($t) { $f = Join-Path $env:TEMP $("synara-beta-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-windows.ps1" -UseBasicParsing -OutFile $f -ErrorAction Stop; Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; Unblock-File -Path $f; try { & $f -Tag $t } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue } } else { throw "Could not resolve the latest Synara Beta release." }',
  },
];

function TerminalInstall() {
  const [copiedOs, setCopiedOs] = useState<string | null>(null);

  const copy = (os: string, command: string) => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopiedOs(os);
      window.setTimeout(() => setCopiedOs(null), 2500);
    });
  };

  return (
    <div className="mt-10 w-full rounded-2xl border border-[var(--divide)] bg-[var(--page-bg)] p-5 text-left">
      <p className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
        <LuTerminal className="size-4" aria-hidden="true" />
        Or install from your terminal
      </p>
      <p className="mt-1 text-[12px] leading-[1.6] text-[var(--text-tertiary)]">
        One release-pinned command. Downloads are checksum-verified against a signed manifest.
      </p>
      <div className="mt-4 flex flex-col gap-2">
        {TERMINAL_INSTALL_COMMANDS.map(({ os, command }) => (
          <button
            key={os}
            type="button"
            onClick={() => copy(os, command)}
            className="group flex w-full items-center gap-3 rounded-xl border border-[var(--divide)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--mock-row)]"
            aria-label={`Copy the ${os} install command`}
          >
            <span className="w-36 shrink-0 text-[12px] font-medium text-[var(--text-secondary)]">
              {os}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-tertiary)]">
              {command}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-[var(--accent-link)]">
              {copiedOs === os ? (
                <>
                  <LuCheck className="size-3.5" aria-hidden="true" /> Copied
                </>
              ) : (
                "Copy"
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PlatformCard({
  index,
  icon,
  name,
  subtitle,
  href,
  recommended,
  children,
}: {
  index: number;
  icon: ReactNode;
  name: string;
  subtitle: string;
  href: string;
  recommended: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      style={{ animationDelay: `${index * 90}ms` }}
      className={`animate-rise-in relative flex flex-col items-center rounded-2xl border bg-[var(--block-elevated)] px-5 pb-5 pt-7 text-center transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 ${
        recommended
          ? "border-[var(--accent-link)]/40 ring-1 ring-[var(--accent-link)]/30"
          : "border-[var(--divide)]"
      }`}
    >
      {recommended ? (
        <span className="absolute -top-2.5 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--accent-link)]/30 bg-[var(--page-bg)] px-2.5 py-0.5 text-[10.5px] font-medium text-[var(--accent-link)]">
          <LuCheck className="size-3" aria-hidden="true" />
          For your device
        </span>
      ) : null}

      <span className="flex h-7 items-center justify-center text-[var(--text-primary)]">
        {icon}
      </span>

      <h2 className="mt-3 text-[15px] font-medium tracking-[-0.02em] text-[var(--text-primary)]">
        {name}
      </h2>
      <p className="mt-1 text-[12px] text-[var(--text-tertiary)]">{subtitle}</p>

      {/* Pinned to the bottom so every card's Download button lines up. */}
      <div className="mt-auto w-full pt-6">
        {children ? <div className="mb-3 flex justify-center">{children}</div> : null}
        <a
          href={href}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-[var(--btn-primary-bg)] px-4 py-2.5 text-[13px] font-medium text-[var(--btn-primary-fg)] transition-opacity hover:opacity-90"
        >
          Download
          <LuArrowDownToLine className="size-4" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

const ARCH_OPTIONS = [
  { value: "arm64", label: "Apple Silicon" },
  { value: "x64", label: "Intel" },
] as const;

const LINUX_ARCH_OPTIONS = [
  { value: "x64", label: "x86_64" },
  { value: "arm64", label: "ARM64" },
] as const;

function ArchToggle({
  ariaLabel,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  options: ReadonlyArray<{ value: MacArch; label: string }>;
  value: MacArch;
  onChange: (arch: MacArch) => void;
}) {
  const activeIndex = options.findIndex((option) => option.value === value);

  return (
    <div
      className="relative inline-grid rounded-full border border-[var(--divide)] p-0.5 text-[12px]"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      role="group"
      aria-label={ariaLabel}
    >
      {/* Dark indicator that slides to the selected segment. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-full bg-[var(--btn-primary-bg)] transition-transform duration-300 ease-out"
        style={{
          width: `calc((100% - 0.25rem) / ${options.length})`,
          transform: `translateX(${Math.max(activeIndex, 0) * 100}%)`,
        }}
      />
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`relative z-10 rounded-full px-3 py-1 font-medium transition-colors duration-200 ${
              active
                ? "text-[var(--btn-primary-fg)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
