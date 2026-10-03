/**
 * The Tauri implementation of the `Platform` port.
 *
 * Deliberately dumb: every method is a one-line `invoke` of a command defined
 * in `src-tauri/src/platform.rs`. No validation, no path fixing, no cleverness
 * happens here — because this file runs in the webview, which is the least
 * trusted part of the application. Anything enforced here could be bypassed by
 * whatever else ends up running in that context, so all of it is enforced in
 * Rust and this is just the phone line.
 */

import type {
  AppEntry,
  AudioDevices,
  AudioLevel,
  AppVolume,
  BinItem,
  BrightnessInfo,
  ChangedFile,
  LargestSubfolders,
  MediaResult,
  MediaInfo,
  Specs,
  WingetPackage,
  PowerPlan,
  PrinterList,
  SpeedResult,
  StartupApp,
  FileComparison,
  ArchiveListing,
  CleanupScan,
  CleanupDone,
  ProcessDetails,
  FirmwareInfo,
  SecurityStatus,
  FoundFiles,
  FolderComparison,
  PingResult,
  GitBranches,
  ExplorerOptions,
  NowPlaying,
  RadioInfo,
  Duplicates,
  FileAttributes,
  CapabilityName,
  FileEntry,
  Platform,
  ProcessEntry,
  SystemSnapshot,
  NetworkAdapter,
  ServiceDetail,
  ServiceEntry,
  ServiceOutcome,
  EnvironmentScope,
  EnvVar,
  FolderSize,
  LargestFiles,
  SpeechVoice,
  Transcript,
  WebPage,
  WifiStatus,
  PathInfo,
  WebSearchResult,
  WindowEntry,
  CursorPosition,
  MouseButton,
  UiaNode,
  DisplayInfo,
  WindowsCompatibility,
  DepManager,
  DevTool,
  GitLogEntry,
  GitStatus,
  ProjectInfo,
  SearchMatch,
  ToolResult,
  TreeEntry,
  HaltEvent,
  HaltStatus,
  ElevationOutcome,
  ElevationRequest,
  InputProbe,
} from '@atlas/core';
import { parseInputBlock } from '@atlas/core';
import { invoke } from '@tauri-apps/api/core';

/**
 * An input command. If the native side refuses the target — a Windows
 * permission screen, a window running above Atlas, something it can't identify
 * — that arrives as an `InputBlockedError` rather than as an anonymous string,
 * so the reason survives all the way to what the person is told.
 */
function invokeInput<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((err: unknown) => {
    throw parseInputBlock(err) ?? err;
  });
}

export function createTauriPlatform(): Platform {
  return {
    id: 'tauri',

    capabilities: () => invoke<CapabilityName[]>('capabilities'),

    searchFiles: (query, opts) =>
      invoke<FileEntry[]>('search_files', {
        query,
        kind: opts?.kind ?? null,
        limit: opts?.limit ?? null,
      }),

    openPath: (path) => invoke<boolean>('open_path', { path }),
    revealPath: (path) => invoke<boolean>('reveal_path', { path }),
    openUrl: (url) => invoke<boolean>('open_url', { url }),

    listApps: () => invoke<AppEntry[]>('list_apps'),
    launchApp: (id) => invoke<boolean>('launch_app', { id }),
    openUrlWithApp: (appId, url) => invoke<boolean>('open_url_with_app', { appId, url }),

    systemInfo: () => invoke<SystemSnapshot>('system_info'),
    runningProcesses: (limit) =>
      invoke<ProcessEntry[]>('running_processes', { limit: limit ?? null }),
    audioDevices: () => invoke<AudioDevices>('audio_devices'),

    readClipboard: async () => {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
      return (await readText()) ?? '';
    },
    writeClipboard: async (text) => {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
      return true;
    },

    showWindow: () => invoke<void>('show_window'),
    hideWindow: () => invoke<void>('hide_window'),
    toggleWindow: () => invoke<void>('toggle_window'),

    createFile: (path, content) =>
      invoke<boolean>('create_file', { path, content: content ?? null }),
    createFolder: (path) => invoke<boolean>('create_folder', { path }),
    renamePath: (path, newName) => invoke<boolean>('rename_path', { path, newName }),
    movePath: (path, destDir) => invoke<boolean>('move_path', { path, destDir }),
    movePathTo: (from, to) => invoke<boolean>('move_path_to', { from, to }),
    copyPath: (path, destDir) => invoke<boolean>('copy_path', { path, destDir }),
    deletePath: (path) => invoke<boolean>('delete_path', { path }),
    readTextFile: (path) => invoke<string>('read_text_file', { path }),

    pathInfo: (path) => invoke<PathInfo>('path_info', { path }),
    probePath: (path) => invoke<PathInfo>('probe_path', { path }),
    appendFile: (path, content) => invoke<boolean>('append_file', { path, content }),
    listDir: (path, limit) => invoke<FileEntry[]>('list_dir', { path, limit: limit ?? null }),
    knownFolder: (id) => invoke<string>('known_folder', { id }),

    lockWorkstation: () => invoke<boolean>('lock_workstation'),
    powerAction: (action) => invoke<boolean>('power_action', { action }),
    mediaKey: (key) => invoke<boolean>('media_key', { key }),
    setVolume: (direction, steps) =>
      invoke<boolean>('set_volume', { direction, steps: steps ?? null }),
    toggleMute: () => invoke<boolean>('toggle_mute'),
    displayOff: () => invoke<boolean>('display_off'),
    powerStates: () => invoke<{ sleep: boolean; hibernate: boolean }>('power_states'),
    sleepPc: (kind) => invoke<boolean>('sleep_pc', { kind }),
    scheduleShutdown: (action, seconds) => invoke<boolean>('schedule_shutdown', { action, seconds }),
    cancelShutdown: () => invoke<boolean>('cancel_shutdown'),
    volumeState: () => invoke<AudioLevel>('volume_state'),
    volumeSet: (level, muted) => invoke<AudioLevel>('volume_set', { level, muted }),
    micState: () => invoke<AudioLevel>('mic_state'),
    micSet: (level, muted) => invoke<AudioLevel>('mic_set', { level, muted }),
    themeGet: () => invoke<'light' | 'dark'>('theme_get'),
    themeSet: (mode) => invoke<boolean>('theme_set', { mode }),
    emptyRecycleBin: () => invoke<boolean>('empty_recycle_bin'),

    wingetSearch: (query) => invoke<WingetPackage[]>('winget_search', { query }),
    wingetInstall: (id) => invoke<string>('winget_install', { id }),
    wingetUninstall: (id) => invoke<string>('winget_uninstall', { id }),
    wingetUpgrade: (id) => invoke<string>('winget_upgrade', { id }),
    wingetUpgrades: () => invoke<WingetPackage[]>('winget_upgrades'),
    hardwareSpecs: () => invoke<Specs>('hardware_specs'),
    flushDns: () => invoke<string>('flush_dns'),
    scaffoldProject: (parent, name, template) => invoke<ToolResult>('scaffold_project', { parent, name, template }),
    deployProject: (cwd, target) => invoke<ToolResult>('deploy_project', { cwd, target }),
    compressVideo: (path, level) => invoke<MediaResult>('compress_video', { path, level }),
    convertMedia: (path, format) => invoke<MediaResult>('convert_media', { path, format }),
    resizeImage: (path, width, percent) => invoke<MediaResult>('resize_image', { path, width, percent }),
    mediaInfo: (path) => invoke<MediaInfo>('media_info', { path }),
    editMedia: (path, op, a, b) => invoke<MediaResult>('edit_media', { path, op, a: a ?? null, b: b ?? null }),
    playSound: (kind, volume) => invoke<boolean>('play_alert_sound', { kind, volume: volume ?? null }),
    brightnessGet: () => invoke<BrightnessInfo>('brightness_get'),
    brightnessSet: (level) => invoke<BrightnessInfo>('brightness_set', { level }),
    appVolumes: () => invoke<AppVolume[]>('app_volumes'),
    setAppVolume: (app, level, muted) => invoke<AppVolume[]>('set_app_volume', { app, level, muted }),
    powerPlan: () => invoke<PowerPlan>('power_plan'),
    setPowerPlan: (plan) => invoke<PowerPlan>('set_power_plan', { plan }),
    projectDisplay: (mode) => invoke<boolean>('project_display', { mode }),
    recycleBinList: (limit) => invoke<BinItem[]>('recycle_bin_list', { limit: limit ?? null }),
    recycleBinRestore: (name) => invoke<BinItem>('recycle_bin_restore', { name }),
    startupApps: () => invoke<StartupApp[]>('startup_apps'),
    setStartupApp: (name, enabled) => invoke<StartupApp>('set_startup_app', { name, enabled }),
    openSettingsPage: (page) => invoke<boolean>('open_settings_page', { page }),
    printers: () => invoke<PrinterList>('printers'),
    setDefaultPrinter: (name) => invoke<PrinterList>('set_default_printer', { name }),
    printFile: (path) => invoke<boolean>('print_file', { path }),
    speedTest: () => invoke<SpeedResult>('speed_test'),
    setWallpaper: (path) => invoke<boolean>('set_wallpaper', { path }),
    mouseSpeed: () => invoke<number>('mouse_speed'),
    setMouseSpeed: (speed) => invoke<number>('set_mouse_speed', { speed }),
    explorerOptions: () => invoke<ExplorerOptions>('explorer_options'),
    setExplorerOption: (which, show) => invoke<ExplorerOptions>('set_explorer_option', { which, show }),
    restartExplorer: () => invoke<number>('restart_explorer'),
    doNotDisturb: () => invoke<boolean>('do_not_disturb'),
    setDoNotDisturb: (on) => invoke<boolean>('set_do_not_disturb', { on }),
    radios: () => invoke<RadioInfo[]>('radios'),
    setRadio: (kind, on) => invoke<RadioInfo[]>('set_radio', { kind, on }),
    nowPlaying: () => invoke<NowPlaying | null>('now_playing'),
    setShuffle: (on) => invoke<boolean>('set_shuffle', { on }),

    zipPath: (path, destDir) => invoke<string>('zip_path', { path, destDir: destDir ?? null }),
    unzipPath: (path, destDir) => invoke<string>('unzip_path', { path, destDir: destDir ?? null }),
    findDuplicates: (path) => invoke<Duplicates>('find_duplicates', { path }),
    compareFiles: (a, b) => invoke<FileComparison>('compare_files', { a, b }),
    duplicatePath: (path) => invoke<string>('duplicate_path', { path }),
    createShortcut: (target, dir, name) => invoke<string>('create_shortcut', { target, dir, name: name ?? null }),
    createUrlShortcut: (url, name, dir) => invoke<string>('create_url_shortcut', { url, name, dir }),
    cleanupScan: (kind) => invoke<CleanupScan>('cleanup_scan', { kind }),
    cleanupClean: (kind, expectedFiles, expectedBytes) => invoke<CleanupDone>('cleanup_clean', { kind, expectedFiles, expectedBytes }),
    fileHash: (path) => invoke<{ sha256: string; sizeBytes: number }>('file_hash', { path }),
    listArchive: (path, limit) => invoke<ArchiveListing>('list_archive', { path, limit: limit ?? null }),
    findFiles: (q) =>
      invoke<FoundFiles>('find_files', {
        path: q.path,
        ext: q.ext ?? null,
        minBytes: q.minBytes ?? null,
        maxBytes: q.maxBytes ?? null,
        modifiedWithinDays: q.modifiedWithinDays ?? null,
        olderThanDays: q.olderThanDays ?? null,
        empty: q.empty ?? null,
        limit: q.limit ?? null,
      }),
    compareFolders: (a, b) => invoke<FolderComparison>('compare_folders', { a, b }),
    pingHost: (host) => invoke<PingResult>('ping_host', { host }),
    toolVersions: () => invoke<{ git: string | null; ffmpeg: string | null }>('tool_versions'),
    dnsLookup: (host) => invoke<string[]>('dns_lookup', { host }),
    traceRoute: (host) => invoke<string[]>('trace_route', { host }),
    processDetails: (pid) => invoke<ProcessDetails>('process_details', { pid }),
    firmwareInfo: () => invoke<FirmwareInfo>('firmware_info'),
    securityStatus: () => invoke<SecurityStatus>('security_status'),
    recentChanges: (path, hours, limit) =>
      invoke<ChangedFile[]>('recent_changes', { path, hours, limit: limit ?? null }),
    fileAttributes: (path) => invoke<FileAttributes>('file_attributes', { path }),
    setFileAttributes: (path, readOnly, hidden) =>
      invoke<FileAttributes>('set_file_attributes', { path, readOnly, hidden }),

    openSystemTool: (id) => invoke<boolean>('open_system_tool', { id }),

    searchWeb: (query) => invoke<WebSearchResult[]>('web_search', { query }),
    searchWebWith: (provider, query, options) =>
      invoke<WebSearchResult[]>('web_search_with', {
        provider,
        query,
        topic: options?.topic ?? null,
      }),
    searchProviderReady: (provider) =>
      invoke<boolean>('web_search_provider_ready', { provider }).catch(() => false),
    fetchPage: (url) => invoke<WebPage>('fetch_page', { url }),

    notify: async (title, body) => {
      const { isPermissionGranted, requestPermission, sendNotification } =
        await import('@tauri-apps/plugin-notification');
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === 'granted';
      if (!granted) return false;
      sendNotification({ title, body });
      return true;
    },

    // Speech. The renderer names a voice by id and supplies text; it cannot
    // point this at an executable or pass engine flags — the same narrow shape
    // every other command here has.
    speechVoices: () => invoke<SpeechVoice[]>('speech_voices'),
    // The command returns a `tauri::ipc::Response`, so a WAV crosses as bytes
    // rather than as an array of a hundred thousand numbers. What those bytes
    // *arrive* as depends on which IPC transport Tauri picked, which is why
    // the result goes through `toArrayBuffer` — see the note on it.
    synthesizeSpeech: async (text, options) => {
      const audio = await invoke<unknown>('synthesize_speech', {
        text,
        voiceId: options?.voiceId,
        pace: options?.pace,
      });
      return toArrayBuffer(audio);
    },

    // Load the refined model without saying anything.
    //
    // Reading 163 MB of weights and building the graph takes a second or two,
    // and it happens on the first sentence unless something asks for it
    // sooner. That first sentence is the one a person judges the whole voice
    // by, so this is called when the voice screen opens — the gesture that
    // most reliably precedes speech by a few seconds.
    //
    // Resolves false, not an error, when the refined voice is not installed:
    // "there was nothing to warm" is an ordinary outcome, not a failure.
    warmSpeech: () => invoke<boolean>('kokoro_warm'),

    // The WAV goes over as the request *body* rather than as an argument: a
    // few seconds of audio is ~100 KB, and JSON would turn that into an array
    // of a hundred thousand numbers to cross one process boundary. The
    // vocabulary hint rides in a header because the body is already spoken
    // for, percent-encoded because header values are bytes and app names are
    // not necessarily ASCII.
    transcribeSpeech: (audio, hints) =>
      invoke<Transcript>('transcribe_speech', new Uint8Array(audio), {
        headers: hints ? { 'Atlas-Hints': encodeURIComponent(hints) } : {},
      }),

    networkAdapters: () => invoke<NetworkAdapter[]>('network_adapters'),
    wifiStatus: () => invoke<WifiStatus>('wifi_status'),
    wifiNetworks: () => invoke<string[]>('wifi_networks'),
    networkReachable: () => invoke<boolean>('network_reachable'),

    listServices: () => invoke<ServiceEntry[]>('list_services'),
    serviceDetail: (name) => invoke<ServiceDetail>('service_detail', { name }),
    serviceControl: (name, action) => invoke<ServiceOutcome>('service_control', { name, action }),

    listEnvironmentVariables: () => invoke<EnvVar[]>('list_environment_variables'),
    setEnvironmentVariable: (name, value, scope) =>
      invoke<boolean>('set_environment_variable', { name, value, scope }),
    deleteEnvironmentVariable: (name, scope: EnvironmentScope) =>
      invoke<boolean>('delete_environment_variable', { name, scope }),

    largestSubfolders: (path, limit) => invoke<LargestSubfolders>('largest_subfolders', { path, limit: limit ?? null }),
    folderSize: (path) => invoke<FolderSize>('folder_size', { path }),
    largestFiles: (path, limit) =>
      invoke<LargestFiles>('largest_files', { path, limit: limit ?? null }),

    detectProject: (cwd) => invoke<ProjectInfo>('detect_project', { cwd }),
    dirTree: (cwd, maxDepth, maxEntries) =>
      invoke<TreeEntry[]>('dir_tree', {
        cwd,
        maxDepth: maxDepth ?? null,
        maxEntries: maxEntries ?? null,
      }),
    codeSearch: (cwd, query, glob, limit) =>
      invoke<SearchMatch[]>('code_search', {
        cwd,
        query,
        glob: glob ?? null,
        limit: limit ?? null,
      }),
    gitStatus: (cwd) => invoke<GitStatus>('git_status', { cwd }),
    gitDiff: (cwd, path) => invoke<string>('git_diff', { cwd, path: path ?? null }),
    gitLog: (cwd, limit) => invoke<GitLogEntry[]>('git_log', { cwd, limit: limit ?? null }),
    gitAdd: (cwd, path) => invoke<boolean>('git_add', { cwd, path }),
    gitCommit: (cwd, message) => invoke<string>('git_commit', { cwd, message }),
    gitBranches: (cwd) => invoke<GitBranches>('git_branches', { cwd }),
    gitCheckout: (cwd, branch, create) => invoke<string>('git_checkout', { cwd, branch, create }),
    gitPull: (cwd) => invoke<string>('git_pull', { cwd }),
    gitPush: (cwd) => invoke<string>('git_push', { cwd }),
    gitStash: (cwd, action) => invoke<string>('git_stash', { cwd, action }),
    gitMore: (cwd, action, arg) => invoke<string>('git_more', { cwd, action, arg: arg ?? null }),
    openProjectTerminal: (cwd) => invoke<boolean>('open_project_terminal', { cwd }),
    openProjectEditor: (cwd) => invoke<boolean>('open_project_editor', { cwd }),
    runDevTool: (cwd, tool: DevTool, arg) =>
      invoke<ToolResult>('run_devtool', { cwd, tool, arg: arg ?? null }),
    runPowerShell: (script, cwd) =>
      invoke<ToolResult>('run_powershell', { script, cwd: cwd ?? null }),
    installDependency: (cwd, manager: DepManager, pkg, dev) =>
      invoke<ToolResult>('install_dependency', { cwd, manager, package: pkg, dev: dev ?? null }),
    writeTextFile: (path, content) => invoke<boolean>('write_text_file', { path, content }),
    patchTextFile: (path, find, replace, replaceAll) =>
      invoke<string>('patch_text_file', { path, find, replace, replaceAll: replaceAll ?? null }),

    allowedFolders: () => invoke<string[]>('allowed_folders'),
    addAllowedFolder: (path) => invoke<string[]>('add_allowed_folder', { path }),
    removeAllowedFolder: (path) => invoke<string[]>('remove_allowed_folder', { path }),

    listWindows: () => invoke<WindowEntry[]>('list_windows'),
    activeWindow: () => invoke<WindowEntry | null>('active_window'),
    focusWindow: (id) => invoke<boolean>('focus_window', { id }),
    minimizeWindow: (id) => invoke<boolean>('minimize_window', { id }),
    setWindowTopmost: (id, on) => invoke<boolean>('set_window_topmost', { id, on }),
    maximizeWindow: (id) => invoke<boolean>('maximize_window', { id }),
    restoreWindow: (id) => invoke<boolean>('restore_window', { id }),
    setWindowBounds: (id, bounds) =>
      invoke<boolean>('set_window_bounds', {
        id,
        x: bounds.x ?? null,
        y: bounds.y ?? null,
        width: bounds.width ?? null,
        height: bounds.height ?? null,
      }),
    closeWindow: (id) => invoke<boolean>('close_window', { id }),
    endProcess: (pid) => invoke<boolean>('end_process', { pid }),

    moveMouse: (x, y) => invoke<boolean>('move_mouse', { x, y }),
    cursorPosition: () => invoke<CursorPosition>('cursor_position'),
    mouseClick: (x, y, button, double) =>
      invokeInput<boolean>('mouse_click', { x, y, button, double: double ?? null }),
    mouseScroll: (amount) => invokeInput<boolean>('mouse_scroll', { amount }),
    mouseDrag: (fromX, fromY, toX, toY, button) =>
      invokeInput<boolean>('mouse_drag', {
        fromX,
        fromY,
        toX,
        toY,
        button: (button as MouseButton | undefined) ?? null,
      }),
    pressKey: (key) => invokeInput<boolean>('press_key', { key }),
    holdKey: (key, seconds) => invokeInput<boolean>('hold_key', { key, seconds }),
    hotkey: (modifiers, key) => invokeInput<boolean>('hotkey', { modifiers, key }),
    typeText: (text) => invokeInput<boolean>('type_text', { text }),

    uiaTree: (windowId, maxDepth) =>
      invoke<UiaNode>('uia_tree', { windowId, maxDepth: maxDepth ?? null }),
    uiaFocusedElement: () => invoke<UiaNode | null>('uia_focused_element'),
    uiaInvoke: (windowId, path) => invokeInput<boolean>('uia_invoke', { windowId, path }),
    uiaSetExpanded: (windowId, path, expand) =>
      invokeInput<boolean>('uia_set_expanded', { windowId, path, expand }),
    uiaSetValue: (windowId, path, value) =>
      invokeInput<boolean>('uia_set_value', { windowId, path, value }),
    uiaFocus: (windowId, path) => invokeInput<boolean>('uia_focus', { windowId, path }),

    summonKeyStatus: () => invoke<string | null>('summon_key_status'),

    inputProbe: (target) =>
      invoke<InputProbe>('input_probe', {
        x: target?.x ?? null,
        y: target?.y ?? null,
        windowId: target?.windowId ?? null,
      }),

    elevationStatus: () => invoke<{ elevated: boolean }>('elevation_status'),
    elevationPrepare: (op) => invoke<ElevationRequest>('elevation_prepare', { op }),
    elevationRun: (token, commandLine) =>
      invoke<ElevationOutcome>('elevation_run', { token, commandLine }),
    elevationCancel: (token) => invoke<boolean>('elevation_cancel', { token }),

    // Same shape as `synthesizeSpeech`: the command returns a
    // `tauri::ipc::Response`, so the bytes need the same transport-agnostic
    // conversion — see `toArrayBuffer`'s doc comment.
    captureWindow: async (windowId) =>
      toArrayBuffer(await invoke<unknown>('capture_window', { windowId })),
    captureScreen: async () => toArrayBuffer(await invoke<unknown>('capture_screen')),
    captureDisplay: async (index) =>
      toArrayBuffer(await invoke<unknown>('capture_display', { index })),
    listDisplays: () => invoke<DisplayInfo[]>('list_displays'),

    /**
     * Imported where it is used rather than at the top of the file, matching
     * `halt.onHalt`'s dynamic import of the event API: the dialog plugin is
     * only reachable from one button, and a person who never clicks it should
     * not pay for the module.
     */
    pickFiles: async (options) => {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: options?.multiple ?? true,
        directory: false,
        title: options?.title,
        filters: options?.filters,
      });
      if (!picked) return [];
      return Array.isArray(picked) ? picked : [picked];
    },
    onFileDrag: async (handler) => {
      // The webview swallows an OS drag, so this is the only place a dropped
      // file's path is available. Positions arrive in physical pixels.
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      return getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'leave') {
          handler({ phase: 'leave', paths: [], x: 0, y: 0 });
          return;
        }
        const scale = window.devicePixelRatio || 1;
        handler({
          phase: payload.type,
          paths: 'paths' in payload ? payload.paths : [],
          x: payload.position.x / scale,
          y: payload.position.y / scale,
        });
      });
    },
    pickFolder: async (options) => {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ multiple: false, directory: true, title: options?.title });
      return typeof picked === 'string' ? picked : null;
    },
    windowsCompatibility: () => invoke<WindowsCompatibility>('windows_compatibility'),

    logDiagnostic: (scope, message) => invoke<void>('log_diagnostic', { scope, message }),

    // The emergency stop. `onHalt` listens for the native event rather than
    // for the button's own promise, so a halt from the key and a halt from the
    // button reach the app through exactly the same path.
    halt: {
      now: () => invoke<number>('halt_now'),
      status: () => invoke<HaltStatus>('halt_status'),
      reset: (epoch) => invoke<boolean>('halt_reset', { epoch }),
      setShortcut: (shortcut) => invoke<HaltStatus>('set_halt_shortcut', { shortcut }),
      setWorking: (working) => invoke<void>('halt_set_working', { working }),
      onHalt: async (listener) => {
        const { listen } = await import('@tauri-apps/api/event');
        return listen<HaltEvent>('atlas://halt', (event) => listener(event.payload));
      },
    },
  };
}

/**
 * Whatever the IPC handed back, as an `ArrayBuffer`.
 *
 * Tauri has two transports for a command result and they do not agree on how
 * bytes look on arrival. The custom-protocol transport answers with
 * `application/octet-stream` and the page reads a real `ArrayBuffer`. The
 * `postMessage` fallback cannot carry bytes, so a payload over 1 KB is
 * serialised as a JSON array of numbers instead — which every consumer here
 * would then quietly reject, because `decodeAudioData` wants a buffer and an
 * `Array` has no `byteLength` to fail a length check on. Silence, no error.
 *
 * The fallback is not hypothetical: it is what runs whenever the app's CSP
 * omits `connect-src ipc: http://ipc.localhost`, since blocking that fetch is
 * exactly how Tauri decides the custom protocol is unavailable. The CSP now
 * allows it, so the fast path is the normal one — this is here so that a
 * transport change can never again turn into a feature that makes no sound.
 */
function toArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    // A view may cover part of a larger buffer; copy the window it describes
    // rather than handing out the whole thing.
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(value)) return Uint8Array.from(value as number[]).buffer;
  return new ArrayBuffer(0);
}

/**
 * Are we running inside Tauri?
 *
 * Checked on a global the runtime injects rather than by user-agent sniffing or
 * by trying an invoke and catching — both of which are guesses. This is a fact.
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
