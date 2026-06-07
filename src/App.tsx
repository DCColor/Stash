import { useState, useEffect, useCallback } from "react";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { readDir, rename } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";

const MAX_CLIPS = 20;

interface ClipItem {
  id: string;
  text: string;
  timestamp: number;
  source: string;
  pinned: boolean;
}

interface Settings {
  menuBarMode: boolean;
  clipLimit: number;
}

const defaultSettings: Settings = { menuBarMode: false, clipLimit: 20 };

const CLIPS_FILE = "stash-clips.json";
const SETTINGS_FILE = "stash-settings.json";

const saveSettings = async (s: Settings) => {
  try {
    const { appDataDir } = await import("@tauri-apps/api/path");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const dir = await appDataDir();
    await writeTextFile(dir + SETTINGS_FILE, JSON.stringify(s));
  } catch {}
};

const loadSettings = async (): Promise<Settings> => {
  try {
    const { appDataDir } = await import("@tauri-apps/api/path");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const dir = await appDataDir();
    const data = await readTextFile(dir + SETTINGS_FILE);
    return { ...defaultSettings, ...JSON.parse(data) };
  } catch {
    return defaultSettings;
  }
};

const saveClips = async (clips: ClipItem[]) => {
  try {
    const { appDataDir } = await import("@tauri-apps/api/path");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const dir = await appDataDir();
    await writeTextFile(dir + CLIPS_FILE, JSON.stringify(clips));
  } catch {}
};

const loadClips = async (): Promise<ClipItem[]> => {
  try {
    const { appDataDir } = await import("@tauri-apps/api/path");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const dir = await appDataDir();
    const data = await readTextFile(dir + CLIPS_FILE);
    return JSON.parse(data);
  } catch {
    return [];
  }
};

export default function App() {
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [activeTab, setActiveTab] = useState<"clipboard" | "rename" | "settings">("clipboard");
  const [lastClip, setLastClip] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [useNumbering, setUseNumbering] = useState(false);
  const [numberStart, setNumberStart] = useState(1);
  const [numberPadding, setNumberPadding] = useState(2);
  const [preview, setPreview] = useState<{ original: string; renamed: string }[]>([]);
  const [renameStatus, setRenameStatus] = useState("");
  const [lockOrder, setLockOrder] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        const currentVersion = await getVersion();
        const res = await fetch("https://releases.graviton.tools/stash/manifest");
        const manifest = await res.json();
        const latest = manifest.version;
        if (latest && latest !== currentVersion) {
          setUpdateAvailable(latest);
        }
      } catch {}
    };
    const timer = setTimeout(checkForUpdates, 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    invoke("set_menu_bar_mode", { enabled: settings.menuBarMode });
  }, [settings.menuBarMode]);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    win.onFocusChanged(({ payload: focused }) => {
      if (!focused && settings.menuBarMode) win.hide();
    }).then(f => unlisten = f);
    return () => { if (unlisten) unlisten(); };
  }, [settings.menuBarMode]);

  useEffect(() => {
    const init = async () => {
      const [saved, currentClip] = await Promise.all([
        loadClips(),
        readText().catch(() => "")
      ]);
      if (saved.length > 0) setClips(saved);
      if (currentClip) setLastClip(currentClip);
    };
    init();
  }, []);

  useEffect(() => {
    saveClips(clips);
  }, [clips]);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const text = await readText();
        if (text && text !== lastClip && text.trim() !== "") {
          setLastClip(text);
          const source = await invoke<string>("get_frontmost_app");
          setClips((prev) => {
            const exists = prev.find((c) => c.text === text);
            if (exists) return prev;
            const newClip: ClipItem = { id: crypto.randomUUID(), text, source, timestamp: Date.now(), pinned: false };
            return [newClip, ...prev].slice(0, MAX_CLIPS);
          });
        }
      } catch {}
    }, 1000);
    return () => clearInterval(interval);
  }, [lastClip]);

  useEffect(() => {
    const setup = async () => {
      try {
        await unregisterAll();
        await register("CommandOrControl+Shift+V", async () => {
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
        });
      } catch {}
    };
    setup();
    return () => { unregisterAll(); };
  }, []);

  const pasteClip = async (clip: ClipItem) => {
    await writeText(clip.text);
    if (!lockOrder && !clip.pinned) {
      setClips((prev) => [clip, ...prev.filter((c) => c.id !== clip.id)]);
    }
  };

  const deleteClip = (id: string) => setClips((prev) => prev.filter((c) => c.id !== id));
  const clearAll = () => setClips([]);

  const togglePin = (id: string) => {
    setClips((prev) => {
      const updated = prev.map((c) => c.id === id ? { ...c, pinned: !c.pinned } : c);
      const pinned = updated.filter((c) => c.pinned);
      const unpinned = updated.filter((c) => !c.pinned);
      return [...pinned, ...unpinned];
    });
  };

  const pickFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose a folder to rename files in"
    });
    if (selected && typeof selected === "string") {
      setFolderPath(selected);
      setRenameStatus("Loading...");
      try {
        const entries = await readDir(selected);
        const names = entries.filter((e) => e.name && !e.name.startsWith(".")).map((e) => e.name!).sort();
        if (names.length < 2) {
          setRenameStatus("Select a folder with 2 or more files — use Finder to rename single files");
          setFiles([]);
          return;
        }
        setFiles(names);
        setRenameStatus("Loaded " + names.length + " files");
      } catch (e) {
        setRenameStatus("Error: " + String(e));
      }
    }
  };

  const buildPreview = useCallback(() => {
    const result = files.map((name, i) => {
      const ext = name.includes(".") ? "." + name.split(".").pop() : "";
      const base = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
      let newBase = base;
      if (findText) newBase = newBase.split(findText).join(replaceText);
      if (prefix) newBase = prefix + newBase;
      if (suffix) newBase = newBase + suffix;
      if (useNumbering) {
        const num = String(numberStart + i).padStart(numberPadding, "0");
        newBase = num + "_" + newBase;
      }
      return { original: name, renamed: newBase + ext };
    });
    setPreview(result);
  }, [files, findText, replaceText, prefix, suffix, useNumbering, numberStart, numberPadding]);

  useEffect(() => {
    if (files.length > 0) buildPreview();
  }, [files, findText, replaceText, prefix, suffix, useNumbering, numberStart, numberPadding, buildPreview]);

  const doRename = async () => {
    if (!preview.length) return;
    let count = 0;
    for (const { original, renamed } of preview) {
      if (original === renamed) continue;
      try {
        await rename(folderPath + "/" + original, folderPath + "/" + renamed);
        count++;
      } catch {}
    }
    setRenameStatus("Renamed " + count + " files");
    setFiles((prev) => prev.map((f) => { const m = preview.find((p) => p.original === f); return m ? m.renamed : f; }));
    if (count > 0) {
      setFindText("");
      setReplaceText("");
      setPrefix("");
      setSuffix("");
      setUseNumbering(false);
      setFiles([]);
      setPreview([]);
      setFolderPath("");
    }
  };

  const timeAgo = (timestamp: number): string => {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m ago";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h ago";
    const days = Math.floor(hours / 24);
    return days + "d ago";
  };

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100 flex flex-col select-none">
      <div className="h-0.5 w-full bg-gradient-to-r from-blue-500 via-cyan-400 to-blue-600" />
      <div className="flex gap-1 px-4 py-2 border-b border-zinc-700">
        <button
          onClick={() => setActiveTab("clipboard")}
          className={"px-3 py-1 rounded text-sm font-medium transition-colors " + (activeTab === "clipboard" ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-white")}
        >
          Clipboard
        </button>
        <button
          onClick={() => setActiveTab("rename")}
          className={"px-3 py-1 rounded text-sm font-medium transition-colors " + (activeTab === "rename" ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-white")}
        >
          Rename
        </button>
      </div>

      {activeTab === "clipboard" && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
            <span className="text-xs text-zinc-500">{clips.length} items</span>
            <label className="flex items-center gap-1.5 text-xs text-zinc-500 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={lockOrder}
                onChange={(e) => setLockOrder(e.target.checked)}
                className="accent-blue-500"
              />
              Lock order
            </label>
            {clips.length > 0 && (
              <button onClick={clearAll} className="text-xs text-zinc-500 hover:text-red-400 transition-colors">Clear all</button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
            {clips.length === 0 && (
              <div className="flex flex-col items-center justify-center h-48 text-zinc-600">
                <p className="text-sm">Nothing stashed yet</p>
                <p className="text-xs mt-1">Copy something to get started</p>
              </div>
            )}
            {clips.map((clip, i) => (
              <div
                key={clip.id}
                className="group flex items-start gap-2 bg-zinc-800 rounded-lg p-3 cursor-pointer border border-transparent hover:border-blue-500 transition-all"
                onClick={() => pasteClip(clip)}
              >
                <span className="text-xs text-zinc-600 mt-0.5 w-4 shrink-0">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-200 line-clamp-3 break-all">{clip.text}</p>
                  <div className="flex items-center gap-2 mt-1.5 pt-1.5 border-t border-zinc-700">
                    <span className="text-xs text-zinc-500">from {clip.source}</span>
                    <span className="text-xs text-zinc-700">·</span>
                    <span className="text-xs text-zinc-500">{timeAgo(clip.timestamp)}</span>
                  </div>
                </div>
                <div className="flex flex-col items-center gap-2 ml-2 shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); togglePin(clip.id); }}
                    className={"text-base transition-all " + (clip.pinned ? "text-blue-400" : "opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-blue-400")}
                  >
                    {clip.pinned ? "★" : "☆"}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteClip(clip.id); }}
                    className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-xs transition-all"
                  >x</button>
                </div>
              </div>
            ))}
          </div>
          <div className="px-4 py-2 border-t border-zinc-800 flex items-center justify-between">
            <span
              onClick={() => setActiveTab((prev) => prev === "settings" ? "clipboard" : "settings")}
              className="relative text-zinc-600 cursor-pointer hover:text-zinc-400 transition-colors text-base"
              title="Settings"
            >
              ⚙️
              {updateAvailable && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full" />
              )}
            </span>
            <span
              onClick={() => openUrl("https://graviton.tools")}
              className="text-xs text-zinc-600 cursor-pointer hover:text-blue-400 transition-colors"
            >
              More from Graviton.Tools
            </span>
          </div>
        </div>
      )}

      {activeTab === "rename" && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="px-4 py-3 space-y-3 border-b border-zinc-800">
            <div className="flex gap-2">
              <input
                type="text"
                value={folderPath}
                placeholder="Click Load to choose a folder..."
                readOnly
                className="flex-1 bg-zinc-800 text-sm text-zinc-200 placeholder-zinc-600 rounded px-3 py-1.5 border border-zinc-700 focus:outline-none"
              />
              <button onClick={pickFolder} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors">Load</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input type="text" value={findText} onChange={(e) => setFindText(e.target.value)} placeholder="Find..." className="bg-zinc-800 text-sm text-zinc-200 placeholder-zinc-600 rounded px-3 py-1.5 border border-zinc-700 focus:border-blue-500 focus:outline-none" />
              <input type="text" value={replaceText} onChange={(e) => setReplaceText(e.target.value)} placeholder="Replace with..." className="bg-zinc-800 text-sm text-zinc-200 placeholder-zinc-600 rounded px-3 py-1.5 border border-zinc-700 focus:border-blue-500 focus:outline-none" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input type="text" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="Prefix..." className="bg-zinc-800 text-sm text-zinc-200 placeholder-zinc-600 rounded px-3 py-1.5 border border-zinc-700 focus:border-blue-500 focus:outline-none" />
              <input type="text" value={suffix} onChange={(e) => setSuffix(e.target.value)} placeholder="Suffix..." className="bg-zinc-800 text-sm text-zinc-200 placeholder-zinc-600 rounded px-3 py-1.5 border border-zinc-700 focus:border-blue-500 focus:outline-none" />
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
                <input type="checkbox" checked={useNumbering} onChange={(e) => setUseNumbering(e.target.checked)} className="accent-blue-500" />
                Add numbering
              </label>
              {useNumbering && (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-zinc-500">Start</span>
                    <input type="number" value={numberStart} onChange={(e) => setNumberStart(parseInt(e.target.value) || 1)} className="w-14 bg-zinc-800 text-sm text-zinc-200 rounded px-2 py-1 border border-zinc-700 focus:border-blue-500 focus:outline-none" />
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-zinc-500">Digits</span>
                    <input type="number" value={numberPadding} onChange={(e) => setNumberPadding(parseInt(e.target.value) || 2)} className="w-14 bg-zinc-800 text-sm text-zinc-200 rounded px-2 py-1 border border-zinc-700 focus:border-blue-500 focus:outline-none" />
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2">
            {preview.length === 0 && (
              <div className="flex items-center justify-center h-32 text-zinc-600 text-sm">Load a folder to preview renames</div>
            )}
            {preview.map(({ original, renamed }) => (
              <div key={original} className="flex items-center gap-2 py-1.5 border-b border-zinc-800 text-xs">
                <span className="text-zinc-500 flex-1 truncate">{original}</span>
                <span className="text-zinc-600">-&gt;</span>
                <span className={"flex-1 truncate " + (renamed !== original ? "text-blue-400" : "text-zinc-500")}>{renamed}</span>
              </div>
            ))}
          </div>
          <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span
                onClick={() => setActiveTab((prev) => prev === "settings" ? "rename" : "settings")}
                className="relative text-zinc-600 cursor-pointer hover:text-zinc-400 transition-colors text-base"
                title="Settings"
              >
                ⚙️
                {updateAvailable && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full" />
                )}
              </span>
              <span className="text-xs text-zinc-500">{renameStatus}</span>
            </div>
            <button
              onClick={doRename}
              disabled={preview.length === 0}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded transition-colors"
            >
              Rename files
            </button>
          </div>
        </div>
      )}

      {activeTab === "settings" && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">General</h2>
            <div className="space-y-4">
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <p className="text-sm text-zinc-200">Menu bar mode</p>
                  <p className="text-xs text-zinc-600 mt-0.5">
                    {settings.menuBarMode
                      ? "Living in menu bar — disable and restart to show dock icon"
                      : "Enable to hide from dock and live in menu bar"}
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.menuBarMode}
                  onChange={(e) => setSettings(s => ({ ...s, menuBarMode: e.target.checked }))}
                  className="accent-blue-500 w-4 h-4"
                />
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <p className="text-sm text-zinc-200">Clip limit</p>
                  <p className="text-xs text-zinc-600 mt-0.5">Max clips to keep in history</p>
                </div>
                <input
                  type="number"
                  value={settings.clipLimit}
                  onChange={(e) => setSettings(s => ({ ...s, clipLimit: parseInt(e.target.value) || 20 }))}
                  className="w-16 bg-zinc-800 text-sm text-zinc-200 rounded px-2 py-1 border border-zinc-700 focus:border-blue-500 focus:outline-none text-right"
                />
              </label>
            </div>
          </div>
          <div className="px-4 py-3">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Shortcut</h2>
            <div className="flex items-center justify-between">
              <p className="text-sm text-zinc-200">Open Stash</p>
              <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-1 rounded border border-zinc-700">⌘ ⇧ V</span>
            </div>
          </div>
          <div className="px-4 py-3 border-t border-zinc-800">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Updates</h2>
            {updateAvailable ? (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-200">v{updateAvailable} available</p>
                  <p className="text-xs text-zinc-600 mt-0.5">You are on an older version</p>
                </div>
                <button
                  onClick={() => openUrl("https://releases.graviton.tools/stash/mac")}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors"
                >
                  Download
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <p className="text-sm text-zinc-400">Stash is up to date</p>
                <button
                  onClick={async () => {
                    try {
                      const currentVersion = await getVersion();
                      const res = await fetch("https://releases.graviton.tools/stash/manifest");
                      const manifest = await res.json();
                      if (manifest.version !== currentVersion) {
                        setUpdateAvailable(manifest.version);
                      }
                    } catch {}
                  }}
                  className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                >
                  Check now
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
