import { contextBridge, ipcRenderer, webUtils } from "electron";
import { Predicate } from "effect";
import type { DesktopBridge } from "@synara/contracts";
import { normalizeDesktopWsUrl, resolveDesktopWsUrlFromEnv } from "./desktopWsBridge";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import {
  parseQuitConfirmationRequest,
  parseQuitConfirmationResponse,
} from "./runningChatsQuitGuard";

const IPC = DESKTOP_IPC_CHANNELS;

function getDesktopWsUrl(): string | null {
  try {
    const ipcWsUrl = normalizeDesktopWsUrl(ipcRenderer.sendSync(IPC.wsUrl));
    return ipcWsUrl ?? resolveDesktopWsUrlFromEnv(process.env);
  } catch {
    return resolveDesktopWsUrlFromEnv(process.env);
  }
}

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: getDesktopWsUrl,
  // Absolute path for OS-dropped File objects (folders with spaces/parens, etc.).
  getPathForFile: (file: File) => {
    try {
      const path = webUtils.getPathForFile(file);
      return Predicate.isString(path) && path.trim().length > 0 ? path : null;
    } catch {
      return null;
    }
  },
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  saveFile: (input) => ipcRenderer.invoke(IPC.saveFile, input),
  confirm: (message) => ipcRenderer.invoke(IPC.confirm, message),
  setTheme: (theme) => ipcRenderer.invoke(IPC.setTheme, theme),
  getAppIcon: () => ipcRenderer.invoke(IPC.getAppIcon),
  setAppIcon: (icon) => ipcRenderer.invoke(IPC.setAppIcon, icon),
  showContextMenu: (items, position) => ipcRenderer.invoke(IPC.contextMenu, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  showInFolder: (path: string) => ipcRenderer.invoke(IPC.showInFolder, path),
  shell: {
    showInFolder: (path: string) => ipcRenderer.invoke(IPC.showInFolder, path),
  },
  clipboard: {
    writeImagePngDataUrl: (dataUrl: string) => ipcRenderer.invoke(IPC.clipboardWriteImage, dataUrl),
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
    close: () => ipcRenderer.invoke(IPC.windowClose),
    getState: () => ipcRenderer.invoke(IPC.windowGetState),
    onState: (listener) => {
      const wrappedListener = (
        _event: Electron.IpcRendererEvent,
        state: Parameters<typeof listener>[0],
      ) => {
        listener(state);
      };

      ipcRenderer.on(IPC.windowState, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IPC.windowState, wrappedListener);
      };
    },
  },
  customTitleBar: {
    getState: () => ipcRenderer.invoke(IPC.customTitleBarGetState),
    setPreference: (enabled) => ipcRenderer.invoke(IPC.customTitleBarSetPreference, enabled),
    relaunch: () => ipcRenderer.invoke(IPC.customTitleBarRelaunch),
  },
  onMenuAction: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      action: Parameters<typeof listener>[0],
    ) => {
      if (!Predicate.isString(action)) return;
      listener(action);
    };

    ipcRenderer.on(IPC.menuAction, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IPC.menuAction, wrappedListener);
    };
  },
  onQuitConfirmationRequest: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      payload: Parameters<typeof parseQuitConfirmationRequest>[0],
    ) => {
      const request = parseQuitConfirmationRequest(payload);
      if (request) listener(request);
    };

    ipcRenderer.on(IPC.quitConfirmationRequest, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IPC.quitConfirmationRequest, wrappedListener);
    };
  },
  replyQuitConfirmation: (response) => {
    const parsed = parseQuitConfirmationResponse(response);
    if (!parsed) return;
    ipcRenderer.send(IPC.quitConfirmationResponse, parsed);
  },
  getZoomFactor: () => {
    const factor = ipcRenderer.sendSync(IPC.zoomFactor);
    return Predicate.isNumber(factor) && Number.isFinite(factor) && factor > 0 ? factor : 1;
  },
  onZoomFactorChange: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      factor: Parameters<typeof listener>[0],
    ) => {
      if (!Predicate.isNumber(factor) || !Number.isFinite(factor) || factor <= 0) return;
      listener(factor);
    };

    ipcRenderer.on(IPC.zoomFactorChanged, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IPC.zoomFactorChanged, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(IPC.updateGetState),
  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
  downloadUpdate: () => ipcRenderer.invoke(IPC.updateDownload),
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall),
  onUpdateState: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<typeof listener>[0],
    ) => {
      listener(state);
    };

    ipcRenderer.on(IPC.updateState, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IPC.updateState, wrappedListener);
    };
  },
  notifications: {
    isSupported: () => ipcRenderer.invoke(IPC.notificationsIsSupported),
    show: (input) => ipcRenderer.invoke(IPC.notificationsShow, input),
  },
  appSnap: {
    getState: () => ipcRenderer.invoke(IPC.appSnap.getState),
    setEnabled: (enabled) => ipcRenderer.invoke(IPC.appSnap.setEnabled, enabled),
    checkShortcut: (shortcut) => ipcRenderer.invoke(IPC.appSnap.checkShortcut, shortcut),
    setShortcut: (shortcut) => ipcRenderer.invoke(IPC.appSnap.setShortcut, shortcut),
    requestPermissions: () => ipcRenderer.invoke(IPC.appSnap.requestPermissions),
    listPendingCaptures: () => ipcRenderer.invoke(IPC.appSnap.listPendingCaptures),
    acknowledgeCapture: (captureId) =>
      ipcRenderer.invoke(IPC.appSnap.acknowledgeCapture, captureId),
    onCaptured: (listener) => {
      const wrappedListener = (
        _event: Electron.IpcRendererEvent,
        capture: Parameters<typeof listener>[0],
      ) => {
        listener(capture);
      };
      ipcRenderer.on(IPC.appSnap.captured, wrappedListener);
      return () => ipcRenderer.removeListener(IPC.appSnap.captured, wrappedListener);
    },
    onError: (listener) => {
      const wrappedListener = (
        _event: Electron.IpcRendererEvent,
        error: Parameters<typeof listener>[0],
      ) => {
        listener(error);
      };
      ipcRenderer.on(IPC.appSnap.error, wrappedListener);
      return () => ipcRenderer.removeListener(IPC.appSnap.error, wrappedListener);
    },
    onState: (listener) => {
      const wrappedListener = (
        _event: Electron.IpcRendererEvent,
        state: Parameters<typeof listener>[0],
      ) => {
        listener(state);
      };
      ipcRenderer.on(IPC.appSnap.state, wrappedListener);
      return () => ipcRenderer.removeListener(IPC.appSnap.state, wrappedListener);
    },
  },
  storageMigration: {
    readSnapshot: () => ipcRenderer.sendSync(IPC.storageMigration.read),
    acknowledgeSnapshot: () => ipcRenderer.invoke(IPC.storageMigration.acknowledge),
  },
  stableImport: {
    getStatus: () => ipcRenderer.invoke(IPC.stableImport.getStatus),
    run: () => ipcRenderer.invoke(IPC.stableImport.run),
  },
  server: {
    transcribeVoice: (input) => ipcRenderer.invoke(IPC.transcribeVoice, input),
  },
  browser: {
    open: (input) => ipcRenderer.invoke(IPC.browser.open, input),
    close: (input) => ipcRenderer.invoke(IPC.browser.close, input),
    hide: (input) => ipcRenderer.invoke(IPC.browser.hide, input),
    getState: (input) => ipcRenderer.invoke(IPC.browser.getState, input),
    setPanelBounds: async (input) => {
      ipcRenderer.send(IPC.browser.setBounds, input);
    },
    attachWebview: (input) => ipcRenderer.invoke(IPC.browser.attachWebview, input),
    detachWebview: (input) => ipcRenderer.invoke(IPC.browser.detachWebview, input),
    copyLink: (input) => ipcRenderer.invoke(IPC.browser.requestCopyLink, input),
    copyScreenshotToClipboard: (input) =>
      ipcRenderer.invoke(IPC.browser.copyScreenshotToClipboard, input),
    captureScreenshot: (input) => ipcRenderer.invoke(IPC.browser.captureScreenshot, input),
    navigate: (input) => ipcRenderer.invoke(IPC.browser.navigate, input),
    reload: (input) => ipcRenderer.invoke(IPC.browser.reload, input),
    goBack: (input) => ipcRenderer.invoke(IPC.browser.goBack, input),
    goForward: (input) => ipcRenderer.invoke(IPC.browser.goForward, input),
    newTab: (input) => ipcRenderer.invoke(IPC.browser.newTab, input),
    closeTab: (input) => ipcRenderer.invoke(IPC.browser.closeTab, input),
    selectTab: (input) => ipcRenderer.invoke(IPC.browser.selectTab, input),
    openDevTools: (input) => ipcRenderer.invoke(IPC.browser.openDevTools, input),
    annotations: {
      start: (input) => ipcRenderer.invoke(IPC.browser.annotations.start, input),
      cancel: (input) => ipcRenderer.invoke(IPC.browser.annotations.cancel, input),
      syncMarkers: (input) => ipcRenderer.invoke(IPC.browser.annotations.syncMarkers, input),
      onEvent: (listener) => {
        const wrappedListener = (
          _event: Electron.IpcRendererEvent,
          event: Parameters<typeof listener>[0],
        ) => {
          listener(event);
        };
        ipcRenderer.on(IPC.browser.annotations.event, wrappedListener);
        return () => ipcRenderer.removeListener(IPC.browser.annotations.event, wrappedListener);
      },
    },
    onState: (listener) => {
      const wrappedListener = (
        _event: Electron.IpcRendererEvent,
        state: Parameters<typeof listener>[0],
      ) => {
        listener(state);
      };

      ipcRenderer.on(IPC.browser.state, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IPC.browser.state, wrappedListener);
      };
    },
    onBrowserUseOpenPanelRequest: (listener) => {
      const wrappedListener = (
        _event: Electron.IpcRendererEvent,
        request: Parameters<typeof listener>[0],
      ) => {
        listener(request);
      };
      ipcRenderer.on(IPC.browser.requestOpenPanel, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IPC.browser.requestOpenPanel, wrappedListener);
      };
    },
    onBrowserCopyLink: (listener) => {
      const wrappedListener = (
        _event: Electron.IpcRendererEvent,
        payload: Parameters<typeof listener>[0],
      ) => {
        listener(payload);
      };
      ipcRenderer.on(IPC.browser.copyLink, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IPC.browser.copyLink, wrappedListener);
      };
    },
  },
} satisfies DesktopBridge);
