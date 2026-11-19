"""Native file and folder dialogs (browsers never expose real file paths, so the server opens them)."""
import asyncio
from collections import OrderedDict
import json
import logging
import os
import subprocess
import sys
import threading

from aiohttp import web

from . import guard, pathutil, store

# ---------------------------------------------------------------- native file dialog
# Browsers never expose real file paths, so the server (same machine) opens a native dialog.

def _patterns(kinds):
    return [f"*{e}" for k in kinds for e in sorted(pathutil.KIND_EXTS[k])]


def _dialog_filters(kinds):
    """[(label, [patterns])], with an "all supported" entry first when several kinds are allowed."""
    rows = [(k.capitalize() + "s" if k != "audio" else "Audio", _patterns([k])) for k in kinds]
    if len(kinds) > 1:
        rows.insert(0, ("Images, videos and audio", _patterns(kinds)))
    return rows + [("All files", ["*.*"])]


_PS_DIALOG = r"""
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Reference Library'
$d.Multiselect = ($env:LI_MULTI -eq '1')
$d.Filter = $env:LI_FILTER
if ($env:LI_INIT -and (Test-Path -LiteralPath $env:LI_INIT -PathType Container)) { $d.InitialDirectory = $env:LI_INIT }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write(($d.FileNames -join "`n")) }
"""

_TK_DIALOG = r"""
import json, os, sys, tkinter as tk
from tkinter import filedialog
r = tk.Tk(); r.withdraw(); r.attributes("-topmost", True)
types = [(label, " ".join(p)) for label, p in json.loads(os.environ["LI_FILTER"])]
kw = dict(parent=r, initialdir=os.environ.get("LI_INIT") or None, title="Reference Library", filetypes=types)
if os.environ.get("LI_MULTI") == "1":
    sys.stdout.write("\n".join(filedialog.askopenfilenames(**kw)))
else:
    sys.stdout.write(filedialog.askopenfilename(**kw) or "")
"""

# macOS: Tk is often unusable in bundled Pythons (Comfy Desktop's can't find init.tcl); osascript is always
# there. Arguments come in as argv (never pasted into the script), so any path is safe. Cancel returns "".
_MAC_DIALOG = r"""
on run argv
	set multi to (item 1 of argv) is "1"
	set init to item 2 of argv
	set exts to items 3 thru -1 of argv
	activate
	try
		if init is "" then
			set picked to choose file with prompt "Reference Library" of type exts multiple selections allowed multi
		else
			set picked to choose file with prompt "Reference Library" of type exts default location (POSIX file init) multiple selections allowed multi
		end if
	on error number -128
		return ""
	end try
	if class of picked is not list then set picked to {picked}
	set out to {}
	repeat with f in picked
		set end of out to POSIX path of f
	end repeat
	set AppleScript's text item delimiters to linefeed
	return out as text
end run
"""


# The same three helpers for picking a folder (where an export is saved).
_FOLDER_PROMPT = "Reference Library: choose the folder to save the export in"

# Windows: the Explorer-style folder picker (the one "Open" dialogs use, with the address bar, search and
# quick access), reached through its COM interface since Windows PowerShell's own FolderBrowserDialog is the
# old tree-only window. That old window is still the fallback if the helper class can't be compiled here.
_PS_FOLDER_DIALOG = r"""
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
$title = '@PROMPT@'
$init = ''
if ($env:LI_INIT -and (Test-Path -LiteralPath $env:LI_INIT -PathType Container)) { $init = $env:LI_INIT }
$src = @'
using System;
using System.Runtime.InteropServices;
public static class LiFolderPicker {
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    class FileOpenDialog { }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr specs);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, int place);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint form, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    // The picked folder's path, or null if the dialog was cancelled.
    public static string Pick(IntPtr owner, string title, string start) {
        IFileDialog dialog = (IFileDialog)new FileOpenDialog();
        uint options;
        dialog.GetOptions(out options);
        dialog.SetOptions(options | 0x20 | 0x40 | 0x800);  // pick folders, file system only, the path must exist
        dialog.SetTitle(title);
        if (!String.IsNullOrEmpty(start)) {
            try {
                Guid iid = typeof(IShellItem).GUID;
                IShellItem folder;
                SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out folder);
                dialog.SetFolder(folder);
            } catch (Exception) { }  // opens where Windows last had it
        }
        if (dialog.Show(owner) != 0) return null;
        IShellItem picked;
        dialog.GetResult(out picked);
        string path;
        picked.GetDisplayName(0x80058000, out path);  // the file system path
        return path;
    }
}
'@
$picked = $null
$modern = $false
try {
    Add-Type -TypeDefinition $src -ErrorAction Stop
    $picked = [LiFolderPicker]::Pick($owner.Handle, $title, $init)
    $modern = $true
} catch { }
if (-not $modern) {
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    $d.Description = $title
    $d.ShowNewFolderButton = $true
    if ($init) { $d.SelectedPath = $init }
    if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $d.SelectedPath }
}
if ($picked) { [Console]::Out.Write($picked) }
""".replace("@PROMPT@", _FOLDER_PROMPT)

_TK_FOLDER_DIALOG = r"""
import os, sys, tkinter as tk
from tkinter import filedialog
r = tk.Tk(); r.withdraw(); r.attributes("-topmost", True)
sys.stdout.write(filedialog.askdirectory(parent=r, initialdir=os.environ.get("LI_INIT") or None, title="%s", mustexist=True) or "")
""" % _FOLDER_PROMPT

_MAC_FOLDER_DIALOG = r"""
on run argv
	set init to item 1 of argv
	activate
	try
		if init is "" then
			set picked to choose folder with prompt "%s"
		else
			set picked to choose folder with prompt "%s" default location (POSIX file init)
		end if
	on error number -128
		return ""
	end try
	return POSIX path of picked
end run
""" % (_FOLDER_PROMPT, _FOLDER_PROMPT)


def _fake_dialog(queue_file):
    """Automation only (tools/screenshots): when LIBRARY_IMAGE_FAKE_DIALOG names a JSON file holding a
    list of answers (each a list of paths), each dialog takes the next answer instead of opening a
    window. Only whoever starts the server can set it."""
    with _DIALOG_LOCK:
        try:
            with open(queue_file, encoding="utf-8") as f:
                answers = json.load(f)
        except (OSError, ValueError):
            return []
        answer = answers.pop(0) if answers else []
        with open(queue_file, "w", encoding="utf-8") as f:
            json.dump(answers, f)
    return [str(p) for p in answer if isinstance(p, str)]


def _open_file_dialog(initial_dir, multi=False, kinds=("image",), filters=None, exts=None, folder=False):
    """Opens the native file dialog; returns the picked paths ([] if cancelled). `filters`
    ([(label, [patterns])]) and `exts` (for the Mac picker) replace the media types of `kinds`.
    `folder`: a folder is picked instead of files (new folders can be made in the dialog)."""
    if os.environ.get("LIBRARY_IMAGE_FAKE_DIALOG"):
        return _fake_dialog(os.environ["LIBRARY_IMAGE_FAKE_DIALOG"])
    filters = filters or _dialog_filters(list(kinds))
    if folder:
        flt = ""
        init = initial_dir if initial_dir and os.path.isdir(initial_dir) else ""
        if sys.platform == "win32":
            cmd = ["powershell", "-NoProfile", "-STA", "-NonInteractive", "-Command", _PS_FOLDER_DIALOG]
            flags = subprocess.CREATE_NO_WINDOW
        elif sys.platform == "darwin":
            cmd, flags = ["osascript", "-e", _MAC_FOLDER_DIALOG, init], 0
        else:
            cmd, flags = [sys.executable, "-c", _TK_FOLDER_DIALOG], 0
    elif sys.platform == "win32":
        flt = "|".join(f"{label}|{';'.join(p)}" for label, p in filters)
        cmd = ["powershell", "-NoProfile", "-STA", "-NonInteractive", "-Command", _PS_DIALOG]
        flags = subprocess.CREATE_NO_WINDOW
    elif sys.platform == "darwin":
        # No "All files" choice on the Mac picker: only supported extensions can be picked.
        flt = ""
        init = initial_dir if initial_dir and os.path.isdir(initial_dir) else ""  # choose file fails on a missing folder
        exts = exts or [e[1:] for k in kinds for e in sorted(pathutil.KIND_EXTS[k])]
        cmd = ["osascript", "-e", _MAC_DIALOG, "1" if multi else "0", init, *exts]
        flags = 0
    else:
        flt = json.dumps(filters)
        cmd = [sys.executable, "-c", _TK_DIALOG]
        flags = 0
    env = {**os.environ, "LI_INIT": initial_dir or "", "LI_MULTI": "1" if multi else "0", "LI_FILTER": flt}
    # One dialog at a time: a second one would open behind the first and look like a hang.
    if not _DIALOG_LOCK.acquire(blocking=False):
        raise DialogBusy("A file dialog is already open (it may be behind the ComfyUI window).")
    try:
        res = subprocess.run(cmd, capture_output=True, env=env, creationflags=flags, timeout=_DIALOG_TIMEOUT)
    except subprocess.TimeoutExpired:
        return []
    finally:
        _DIALOG_LOCK.release()
    if res.returncode != 0:
        err = res.stderr.decode("utf-8", "replace").strip()
        logging.warning("[library_image] file dialog exited with %s: %s", res.returncode, err)
        raise RuntimeError(err.splitlines()[-1] if err else f"the dialog helper exited with code {res.returncode}")
    out = res.stdout.decode("utf-8", "replace")
    return [p.strip() for p in out.splitlines() if p.strip()]


_DIALOG_LOCK = threading.Lock()
_DIALOG_TIMEOUT = 300  # seconds; a forgotten dialog shouldn't hold the lock forever


class DialogBusy(Exception):
    pass


# Files the user picked in the dialog recently: only these get a thumbnail by path (before they're
# in the library), so /thumb can't be used to read arbitrary files.
_PICKED = OrderedDict()


def _remember_pick(path):
    key = os.path.normcase(pathutil._clean_path(path))
    _PICKED[key] = True
    _PICKED.move_to_end(key)
    while len(_PICKED) > 500:
        _PICKED.popitem(last=False)


def _was_picked(path):
    return os.path.normcase(pathutil._clean_path(path)) in _PICKED


async def _dialog_response(key, current, multi, kinds):
    try:
        # _initial_dir checks the disk: in the worker thread too (a network path can hang).
        paths = await asyncio.to_thread(lambda: _open_file_dialog(_initial_dir(current), multi, kinds))
    except DialogBusy as e:
        return web.json_response({"error": str(e)}, status=409)
    except Exception as e:
        logging.exception("[library_image] file dialog failed")
        return web.json_response({"error": f"File dialog failed: {e}"}, status=500)
    for p in paths:
        _remember_pick(p)
    if paths:
        await asyncio.to_thread(store._trust_folders, paths)
    return web.json_response({key: (paths[0] if paths else None) if key == "path" else paths})


def _initial_dir(current):
    current = pathutil._clean_path(current)
    return current if os.path.isdir(current) else os.path.dirname(current)


def _requested_kinds(body, default=("image",)):
    raw = body.get("kinds")
    kinds = [k for k in raw if isinstance(k, str) and k in pathutil.KIND_EXTS] if isinstance(raw, list) else []
    return tuple(dict.fromkeys(kinds)) or default


async def _browse(request):
    body = await guard._json_body(request)
    return await _dialog_response("path", str(body.get("current") or ""), False, _requested_kinds(body))


async def _pick(request):
    """Native file dialog only (nothing is added): {"paths": [...]}."""
    body = await guard._json_body(request)
    kinds = _requested_kinds(body, default=tuple(pathutil.KIND_EXTS))
    return await _dialog_response(
        "paths", str(body.get("current") or ""), bool(body.get("multi", True)), kinds)
