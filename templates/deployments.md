# Managed deployments

Owner mandate: <who authorized compatible upgrades, repairs and deployment>
Maintainer: <existing agent; host and tool access; independent of app availability>
Schedule/event: <enabled identifier, cadence, and where to inspect it>
Blocked work and last verified results: <private receipt directory>

## <component>

- Repository/release source and eligible branch/channel: <exact identity>
- Target: <host/project/service or hosting project; no credentials>
- Policy: <automatic compatible releases or manual; repair scope and exclusions>
- Check: <native command to compare eligible and running revisions>
- Deploy: <existing workflow/CLI with an exact candidate revision>
- Verify: <running revision/image plus API/UI/agent behavior>
- Roll back: <native command using saved previous release; data limitations>
- Preserve: <volumes, bindings, settings, identities, pending operations>
- Dependencies: <services that must change together; independent components>
- Receipt: <private path with previous/candidate/current identity and result>

Replace placeholders before enabling maintenance. Add a section per component,
including frontend, backend, embedded engine and gateway when owned. Do not put
secrets here, infer ownership from discovery, or treat this inventory as a second
deployment configuration. Follow the installed docs/managed-applications.md.
