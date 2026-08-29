# Contributing

Use Node.js 22.13 or newer and install with `npm ci`.

Before opening a pull request, run:

```powershell
npm run check
```

Use Conventional Commits. Add tests for policy, cache, concurrency, error, or protocol changes. Never commit runtime databases, auth material, real account identifiers, or checkpoint content. Compatibility fallback that reads credentials or undocumented OAuth endpoints is out of scope unless the security model is explicitly redesigned and reviewed.
