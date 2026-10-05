@echo off
rem Recompile le lanceur de developpement (Kartouche-Dev.exe, a la racine du projet). Necessite .NET Framework (present sur Windows).
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /out:"%~dp0..\Kartouche-Dev.exe" "%~dp0KartoucheDev.cs"
