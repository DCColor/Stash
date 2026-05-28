import { useState, useEffect, useCallback } from "react";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { readDir, rename } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

const MAX_CLIPS = 10;

interface ClipItem {
  id: string;
  text: string;
  timestamp: number;
}

export default function App() {
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [activeTab, setActiveTab] = useState<"clipboard" | "rename">("clipboard");
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

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const text = await readText();
        if (text && text !== lastClip && text.trim() !== "") {
          setLastClip(text);
          setClips((prev) => {
            const exists = prev.find((c) => c.text === text);
            if (exists) return prev;
            const newClip: ClipItem = { id: crypto.randomUUID(), text, timestamp: Date.now() };
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
    setClips((prev) => [clip, ...prev.filter((c) => c.id !== clip.id)]);
  };

  const deleteClip = (id: string) => setClips((prev) => prev.filter((c) => c.id !== id));
  const clearAll = () => setClips([]);

  const loadFolder = async () => {
    if (!folderPath.trim()) return;
    try {
      const entries = await readDir(folderPath);
      const names = entries.filter((e) => e.name && !e.name.startsWith(".")).map((e) => e.name!).sort();
      setFiles(names);
      setRenameStatus("Loaded " + names.length + " files");
    } catch {
      setRenameStatus("Could not read folder - check the path");
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
  };

  return (
    <div data-tauri-drag-region className="min-h-screen bg-zinc-900 text-zinc-100 flex flex-col select-none">
      <div data-tauri-drag-region className="flex items-center justify-center px-4 py-2 border-b border-zinc-800" style={{WebkitAppRegion: 'drag'} as any}>
        <span className="text-sm font-bold text-zinc-400">Stash</span>
        <span className="text-xs text-zinc-600 ml-2">by Graviton.Tools</span>
      </div>
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
                <p className="text-sm text-zinc-200 flex-1 line-clamp-3 break-all">{clip.text}</p>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteClip(clip.id); }}
                  className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-xs transition-all shrink-0"
                >x</button>
              </div>
            ))}
          </div>
          <div className="px-4 py-2 border-t border-zinc-800 flex items-center justify-center">
            <span
              onClick={() => openUrl("https://graviton.tools")}
              className="text-xs text-zinc-600 cursor-pointer hover:text-blue-400 transition-colors"
            >
              More tools from Graviton.Tools
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
                onChange={(e) => setFolderPath(e.target.value)}
                placeholder="/Users/you/path/to/folder"
                className="flex-1 bg-zinc-800 text-sm text-zinc-200 placeholder-zinc-600 rounded px-3 py-1.5 border border-zinc-700 focus:border-blue-500 focus:outline-none"
              />
              <button onClick={loadFolder} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors">Load</button>
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
            <span className="text-xs text-zinc-500">{renameStatus}</span>
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
    </div>
  );
}
