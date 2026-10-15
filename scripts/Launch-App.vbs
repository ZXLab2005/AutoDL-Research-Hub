Option Explicit

Dim files, shell, hubRoot, launchScript, powershell, command, exitCode
Set files = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
hubRoot = files.GetParentFolderName(files.GetParentFolderName(WScript.ScriptFullName))
If Len(hubRoot) < 4 Or Mid(hubRoot, 2, 2) <> ":\" Then
    MsgBox "Place the Research Hub in a dedicated local Windows folder.", vbCritical, "AutoDL Research Hub"
    WScript.Quit 1
End If
launchScript = files.BuildPath(hubRoot, "scripts\Launch-App.ps1")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
If Not files.FileExists(launchScript) Or Not files.FileExists(powershell) Then
    MsgBox "The application launcher is missing. Run scripts\Install-AppEntry.ps1 again.", vbCritical, "AutoDL Research Hub"
    WScript.Quit 1
End If
If WScript.Arguments.Count > 0 Then
    If WScript.Arguments(0) = "--check-entry" Then WScript.Quit 0
End If
shell.CurrentDirectory = hubRoot
command = Quote(powershell) & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(launchScript)
exitCode = shell.Run(command, 0, True)
If exitCode <> 0 Then
    MsgBox "The Research Hub could not start. See:" & vbCrLf & files.BuildPath(hubRoot, "data\app\launch.log"), vbCritical, "AutoDL Research Hub"
End If
WScript.Quit exitCode

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function
