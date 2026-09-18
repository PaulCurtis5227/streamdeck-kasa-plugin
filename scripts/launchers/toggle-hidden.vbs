' Runs the Kasa toggle CLI with no visible console window.
' Usage (from a shortcut): wscript.exe "toggle-hidden.vbs" "<host>" ["<outlet name>"]
' The outlet name is optional; omit it for a single-outlet switch.
Option Explicit
Dim fso, sh, q, nodePath, scriptDir, projectRoot, scriptPath, host, outlet, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
q = Chr(34)

' Stable, always-present Node (the CLI is bundled, so no TS support is needed).
nodePath = "C:\Program Files\nodejs\node.exe"

' Resolve the bundle relative to this script's own location (scripts\launchers\)
' so the shortcut works regardless of which machine/user account the project is
' checked out under: this file's folder -> scripts\ -> project root.
scriptDir = fso.GetParentFolderName(fso.GetAbsolutePathName(WScript.ScriptFullName))
projectRoot = fso.GetParentFolderName(fso.GetParentFolderName(scriptDir))
scriptPath = fso.BuildPath(projectRoot, "dist\kasa-toggle.mjs")

If WScript.Arguments.Count = 0 Then
  WScript.Echo "Usage: toggle-hidden.vbs <host> [outlet name]"
  WScript.Quit 1
End If
host = WScript.Arguments(0)

cmd = q & nodePath & q & " " & q & scriptPath & q & " --host " & host

If WScript.Arguments.Count > 1 Then
  outlet = WScript.Arguments(1)
  cmd = cmd & " --outlet " & q & outlet & q
End If

' 0 = hidden window, False = don't wait.
sh.Run cmd, 0, False
