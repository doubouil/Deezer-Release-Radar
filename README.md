# Deezer-Release-Radar
A userscript to view new releases of artist you follow, not the ones Deezer thinks you like. Deezers Release Playlist does not feature small artists and features artists you heard 2 times. This radar features only artists you follow. Designed for the Desktop Browser version, supports both dark and white mode. Tested on Chrome/Firefox with Violentmonkey/Tampermonkey.
![image](https://github.com/user-attachments/assets/10d8a018-9c94-41c8-9863-d983086657c4)

- Adds a menu item right besides the notifications icon
- Allows you to limit the amount of releases by amount or age (highly recommended as the higher the limits, the more requests we need to make)
- Allows you to open the releases in the desktop app
- Scans for new artists every N hours (12 by default), saves the results in cache
- Most actions require a hard reload of the page to apply (changing settings, "automatically" rescanning after the N hours)

> - Does not feature ajax requests when opening the links in the browser (if you have a way/hack to do that (e.g. some form of monkey patching/replacing native links...) please let me know

Note that I will most likely change the look of the indication for new releases, I just dont have any notifications right now, so its hard to mimick the original.
