# Security Principles

Lessons learned from real-world AI agent security failures, particularly the Clawdbot/ClawdHub incidents of January 2026.

## Core Principles

### 1. Trust No External Code

**Never blindly execute code from package registries, skill hubs, or community repositories.**

The ClawdHub supply chain attack demonstrated:
- Download counts are trivially gameable (no auth, spoofed IPs)
- Web UIs hide instruction files that agents actually execute
- "Popular" doesn't mean "safe" - 4,000 downloads can be faked in an hour
- Permission prompts create an *illusion* of control

**Our approach:**
- Skills live in `~/.claude/skills/` where we control them
- No external skill registry - we write our own or review every line
- MCP servers are local packages we build and audit

### 2. Permission Fatigue Is Real

After 50 legitimate "Allow" clicks, users stop reading prompts entirely.

A malicious skill author controls:
- The command text shown in prompts
- The timing and context of requests
- The visual appearance (typosquatting domains like `clawdhub-skill.com`)

**Our approach:**
- Run in trusted mode (YOLO) because we're single-user on our own machine
- Don't expose permission prompts to external services
- Gateway handles all external communication, not Claude directly

### 3. Exposed Servers Get Pwned

Hundreds of Clawdbot Control servers were found exposed:
- API keys and OAuth tokens stolen
- Conversation history accessed
- Commands executed as root
- Full system compromise

**Our approach:**
- Gateway runs locally, not exposed to internet
- Remote access only via Tailscale (authenticated mesh VPN)
- No public endpoints, no exposed ports
- Clients connect through secure tunnel

### 4. The Butler Has All The Keys

An AI agent with full system access is like a butler with keys to everything:
- SSH keys, AWS credentials, git tokens
- Source code, databases, production infrastructure
- Email, messages, personal files

If the agent is compromised, the attacker owns everything.

**Our approach:**
- Single-user system (Michael only)
- No multi-tenant, no shared access
- Memory stored locally in `~/memory/` (not a cloud database)
- Credentials never passed through agent prompts

### 5. Supply Chain Attack Pattern

A real supply chain attack follows this pattern:

1. **Reconnaissance** - Enumerate system, find `.env`, credentials, SSH keys
2. **Exfiltration** - Package and send to attacker's server
3. **Persistence** - Add SSH key, drop cron job for re-entry
4. **Cover tracks** - Clear history, continue helping normally

User sees helpful agent. Credentials are gone. System is backdoored.

**Our approach:**
- Build our own tools (MCP servers, extensions, skills)
- Review every external dependency
- No "download and run" patterns

## Trust Signals That Don't Work

| Signal | Why It Fails |
|--------|--------------|
| Download counts | Trivially inflatable with bash loops |
| Stars/ratings | Gameable with bot accounts |
| "Official" domains | Typosquatting is cheap and easy |
| Permission prompts | Permission fatigue bypasses scrutiny |
| Hidden in disclaimers | Nobody reads terms buried in files |

## Trust Signals That Actually Help

| Signal | Why It Works |
|--------|--------------|
| Read the actual code | You see what runs |
| Known author with reputation | Accountability exists |
| Linked GitHub with history | Transparent development |
| Local-first architecture | Attack surface minimized |
| Code review before use | Human verification |

## Claudia's Architecture Advantages

1. **Gateway-centric** - Not a remote-control wrapper exposing endpoints
2. **Local-first** - Gateway runs on Michael's machines only
3. **Tailscale-secured** - Remote access through authenticated mesh VPN
4. **No external skills** - We build and audit our own
5. **Memory isolation** - Local markdown files, not cloud database
6. **Single user** - No multi-tenant attack surface

## Security Checklist

Even though Claudia is personal and single-user, regular security hygiene is important.

### Network Binding
- [ ] Gateway binds to `127.0.0.1` (localhost) by default
- [ ] Remote access requires explicit Tailscale configuration
- [ ] Port 30086 not exposed to public internet
- [ ] Firewall rules configured if on shared network

### File Permissions
- [ ] `~/.claudia/` directory: `700` (owner only)
- [ ] Config files: `600` (owner read/write only)
- [ ] `~/memory/` directory: `700` (owner only)
- [ ] No credentials stored in plain text config

### Credentials & Secrets
- [ ] API keys in environment variables or secure storage (1Password CLI)
- [ ] No secrets in git history
- [ ] GitHub tokens scoped to minimum required permissions
- [ ] SSH keys use strong passphrases

### Skills & Extensions
- [ ] All skills in `~/.claude/skills/` are self-written or reviewed
- [ ] No external skill registries or "download and run" patterns
- [ ] MCP servers are local packages we build
- [ ] Extensions reviewed before enabling

### Memory & Logs
- [ ] Memory repo is private on GitHub
- [ ] Session transcripts don't contain sensitive data
- [ ] Log files have appropriate permissions

## Security Audit CLI (Planned)

```bash
claudia security check

✓ Gateway bound to localhost (127.0.0.1:30086)
✓ ~/.claudia permissions: 700
✓ Config file permissions: 600
✓ No credentials in config files
✓ Memory repo is private
✓ Tailscale required for remote access
⚠ Port 30086 is listening - ensure firewall configured

All checks passed!
```

The audit command will:
- Verify network binding (localhost only unless Tailscale)
- Check file and directory permissions
- Scan config for exposed credentials
- Verify memory repo privacy
- Check for common misconfigurations

Options:
- `--fix` - Automatically fix safe issues (permissions, etc.)
- `--verbose` - Show detailed information for each check

## References

- [Exposed Clawdbot Servers Analysis](https://x.com/theonejvo/status/2015401219746128322) - @theonejvo, Jan 2026
- [ClawdHub Supply Chain Attack](https://x.com/theonejvo/status/2015892980851474595) - @theonejvo, Jan 2026
- ua-parser-js npm compromise (Oct 2021)
- event-stream npm compromise (2018)
- Shai Hulud campaign (Sep 2025)

---

*"The 16 developers who ran my skill weren't careless or stupid. They made the same reasonable assumptions everyone makes. None of those assumptions are valid."* - @theonejvo
