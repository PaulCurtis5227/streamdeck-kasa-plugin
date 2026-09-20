' Runs the Kasa toggle CLI with no visible console window.
' Usage (from a shortcut): wscript.exe "toggle-hidden.vbs" "<host>" "<outlet name|"">" "<on|off>"
' The outlet name may be an empty string for a single-outlet switch. The action
' is the state a click should force ("on"/"off") — NOT a toggle — so the
' shortcut always does exactly what its filename says, even if the device was
' switched elsewhere since the label was last written.
Option Explicit
Dim fso, sh, q, nodePath, scriptDir, projectRoot, scriptPath, host, outlet, action, cmd
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

If WScript.Arguments.Count < 3 Then
  WScript.Echo "Usage: toggle-hidden.vbs <host> <outlet name|""""> <on|off>"
  WScript.Quit 1
End If
host = WScript.Arguments(0)
outlet = WScript.Arguments(1)
action = LCase(WScript.Arguments(2))

cmd = q & nodePath & q & " " & q & scriptPath & q & " --host " & host

If Len(outlet) > 0 Then
  cmd = cmd & " --outlet " & q & outlet & q
End If

If action = "on" Then
  cmd = cmd & " --on"
ElseIf action = "off" Then
  cmd = cmd & " --off"
End If

' 0 = hidden window, False = don't wait.
sh.Run cmd, 0, False
