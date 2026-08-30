Option Explicit

If WScript.Arguments.Count <> 3 Then WScript.Quit 2

Function Quoted(value)
  Quoted = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

Dim shell, command, result
Set shell = CreateObject("WScript.Shell")
command = Quoted(WScript.Arguments(0)) & " " & Quoted(WScript.Arguments(1)) & " " & Quoted(WScript.Arguments(2))
' Window style 0 is hidden. Wait for the bounded local probe and preserve its exit code.
result = shell.Run(command, 0, True)
WScript.Quit result
