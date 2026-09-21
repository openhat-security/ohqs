# Third-party resources

Upstream checkouts used by the OpenHat Quick Start catalog. Each project keeps its own license — see that tree’s `LICENSE` (or equivalent). This repo does not relicense them.

These trees are **git submodules** listed in [`.gitmodules`](../.gitmodules). A normal clone of this repo does **not** download them (the parent would be huge). Fetch when you want them:

```bash
make submodules                 # all, shallow
ohqs submodules                 # same
ohqs submodules gitleaks nuclei # selected catalog ids
ohqs install --authorized --scope "..." --situation "..."  # only what that playbook needs
```

The YAML source of truth is [`../catalog/`](../catalog/). Maintainers can re-absorb nested clones with [`../scripts/convert-nested-to-submodules.sh`](../scripts/convert-nested-to-submodules.sh).

## Browser extensions

| Local tree | Upstream |
| --- | --- |
| [CyberInject](browser-extensions/CyberInject/) | https://github.com/CyberNilsen/CyberInject |
| [Dependency-Confusion-Hunter](browser-extensions/Dependency-Confusion-Hunter/) | https://github.com/KingOfBugbounty/Dependency-Confusion-Hunter |
| [Firefox-Security-Toolkit](browser-extensions/Firefox-Security-Toolkit/) | https://github.com/mazen160/Firefox-Security-Toolkit |
| [keyFinder](browser-extensions/keyFinder/) | https://github.com/momenbasel/keyFinder |
| [PenScope](browser-extensions/PenScope/) | https://github.com/spider12223/PenScope |
| [pentestkit](browser-extensions/pentestkit/) (OWASP PTK) | https://github.com/DenisPodgurskii/pentestkit |
| [S3BucketList](browser-extensions/S3BucketList/) | https://github.com/AlecBlance/S3BucketList |
| [Trufflehog-Chrome-Extension](browser-extensions/Trufflehog-Chrome-Extension/) | https://github.com/trufflesecurity/Trufflehog-Chrome-Extension |
| [URILoot](browser-extensions/URILoot/) | https://github.com/rsingh0x/URILoot |
| [WebExplode](browser-extensions/WebExplode/) | https://github.com/MacallanTheRoot/WebExplode |
| [XnlReveal](browser-extensions/XnlReveal/) | https://github.com/xnl-h4ck3r/XnlReveal |

Store URL lists: [chrome.txt](browser-extensions/chrome.txt), [firefox.txt](browser-extensions/firefox.txt).

## Guides

| Local tree | Upstream |
| --- | --- |
| [Active-Directory-Exploitation-Cheat-Sheet](guides/Active-Directory-Exploitation-Cheat-Sheet/) | https://github.com/S1ckB0y1337/Active-Directory-Exploitation-Cheat-Sheet |
| [android-penetration-testing-cheat-sheet](guides/android-penetration-testing-cheat-sheet/) | https://github.com/ivan-sincek/android-penetration-testing-cheat-sheet |
| [Awesome-Hacking](guides/Awesome-Hacking/) | https://github.com/Hack-with-Github/Awesome-Hacking |
| [awesome-bug-bounty](guides/awesome-bug-bounty/) | https://github.com/djadmin/awesome-bug-bounty |
| [awesome-bug-bounty-tips](guides/awesome-bug-bounty-tips/) | https://github.com/ajdumanhug/awesome-bug-bounty-tips |
| [awesome-pentest](guides/awesome-pentest/) | https://github.com/enaqx/awesome-pentest |
| [Bug-Bounty](guides/Bug-Bounty/) | https://github.com/AnLoMinus/Bug-Bounty |
| [Bug-Bounty-Resources](guides/Bug-Bounty-Resources/) | https://github.com/securitycipher/Bug-Bounty-Resources |
| [CheatSheetSeries](guides/CheatSheetSeries/) | https://github.com/OWASP/CheatSheetSeries |
| [Cheatsheet-God](guides/Cheatsheet-God/) | https://github.com/OlivierLaflamme/Cheatsheet-God |
| [GTFOBins.github.io](guides/GTFOBins.github.io/) | https://github.com/GTFOBins/GTFOBins.github.io |
| [hacktricks](guides/hacktricks/) | https://github.com/HackTricks-wiki/hacktricks |
| [ios-penetration-testing-cheat-sheet](guides/ios-penetration-testing-cheat-sheet/) | https://github.com/ivan-sincek/ios-penetration-testing-cheat-sheet |
| [PayloadsAllTheThings](guides/PayloadsAllTheThings/) | https://github.com/swisskyrepo/PayloadsAllTheThings |
| [SecLists](guides/SecLists/) | https://github.com/danielmiessler/SecLists |
| [the-book-of-secret-knowledge](guides/the-book-of-secret-knowledge/) | https://github.com/trimstray/the-book-of-secret-knowledge |

## Tools

| Local tree | Upstream |
| --- | --- |
| [amass](tools/amass/) | https://github.com/owasp-amass/amass |
| [Arjun](tools/Arjun/) | https://github.com/s0md3v/Arjun |
| [assetfinder](tools/assetfinder/) | https://github.com/tomnomnom/assetfinder |
| [beef](tools/beef/) | https://github.com/beefproject/beef |
| [commix](tools/commix/) | https://github.com/commixproject/commix |
| [dirsearch](tools/dirsearch/) | https://github.com/maurosoria/dirsearch |
| [evilginx2](tools/evilginx2/) | https://github.com/kgretzky/evilginx2 |
| [feroxbuster](tools/feroxbuster/) | https://github.com/epi052/feroxbuster |
| [ffuf](tools/ffuf/) | https://github.com/ffuf/ffuf |
| [gitleaks](tools/gitleaks/) | https://github.com/gitleaks/gitleaks |
| [gobuster](tools/gobuster/) | https://github.com/OJ/gobuster |
| [httpx](tools/httpx/) | https://github.com/projectdiscovery/httpx |
| [katana](tools/katana/) | https://github.com/projectdiscovery/katana |
| [metasploit-framework](tools/metasploit-framework/) | https://github.com/rapid7/metasploit-framework |
| [mitmproxy](tools/mitmproxy/) | https://github.com/mitmproxy/mitmproxy |
| [nikto](tools/nikto/) | https://github.com/sullo/nikto |
| [nuclei](tools/nuclei/) | https://github.com/projectdiscovery/nuclei |
| [open-kritt](tools/open-kritt/) | https://github.com/Kritt-ai/open-kritt |
| [osv-scanner](tools/osv-scanner/) | https://github.com/google/osv-scanner |
| [reconmap](tools/reconmap/) | https://github.com/reconmap/reconmap |
| [sqlmap](tools/sqlmap/) | https://github.com/sqlmapproject/sqlmap |
| [subfinder](tools/subfinder/) | https://github.com/projectdiscovery/subfinder |
| [SwiftnessX](tools/SwiftnessX/) | https://github.com/ehrishirajsharma/SwiftnessX |
| [trivy](tools/trivy/) | https://github.com/aquasecurity/trivy |
| [trufflehog](tools/trufflehog/) | https://github.com/trufflesecurity/trufflehog |
| [vajra](tools/vajra/) | https://github.com/r3curs1v3-pr0xy/vajra |
| [w3af](tools/w3af/) | https://github.com/andresriancho/w3af |
| [wireshark](tools/wireshark/) | https://gitlab.com/wireshark/wireshark |
| [wpscan](tools/wpscan/) | https://github.com/wpscanteam/wpscan |
| [www-project-zap](tools/www-project-zap/) | OWASP ZAP project site (not the scanner; see [zaproxy](tools/zaproxy/)) |
| [zaproxy](tools/zaproxy/) | https://github.com/zaproxy/zaproxy |

## Operating systems

Distro ISOs are not vendored. See [os/README.md](os/README.md) and `ohqs setup`.
