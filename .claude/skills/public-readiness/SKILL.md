---
name: public-readiness
description: Score how ready this repo is to be published as a public GitHub repo — README quality, plus legality and security — as percentages with the evidence behind each deduction. Use when asked "is this OK to make public", "rate the README", "public readiness", or before pushing the repo public.
---

# Public readiness review

Score the repo out of 100 on two axes, then give an overall score. Read-only: change nothing.
Judge only what would actually be published: files git would commit, not gitignored ones.

## 1. Find what would be published

```bash
git ls-files --cached --others --exclude-standard
cat .gitignore
git log --oneline | head   # history is published too
```

Read every published file that isn't a lockfile. Note what is ignored and check it should be
(generated output, personal data, caches, build output, secrets).

## 2. README (100 points)

Start at 100 and deduct, citing the line or the missing thing for each:

| Check | Max deduction |
|---|---|
| First lines say what it is and who it's for | 10 |
| A screenshot or GIF, for anything visual | 10 |
| Install and run commands that work as written. Check scripts in package.json etc. | 15 |
| Requirements stated: runtime versions, OS, browser, disk or GPU for optional parts | 8 |
| Optional or external pieces explained, with setup steps you can verify against their docs | 12 |
| Says what works today and what is planned (no unmarked roadmap items) | 8 |
| Licence named and LICENSE file present | 10 |
| Claims are true. Spot-check 3+ claims against the code; deduct for each false one | 15 |
| Clear, plain, short; no marketing fluff | 7 |
| Links resolve (relative files exist; external URLs look right) | 5 |

## 3. Legality and security (100 points)

Start at 100 and deduct, with file:line evidence:

**Legality**
- No LICENSE file (−15). A licence that clashes with dependencies (−10).
- Third-party code, assets, fonts or models copied in without their licence (−15 each).
- Trademarks used as the product's name or logo rather than plainly describing it (−10). No "not affiliated" line where a trademark is mentioned prominently (−3).
- Reverse-engineered or closed formats, or anything breaking a service's terms (−20).
- Generated content (AI images or models) published without its licence terms checked (−5).

**Privacy**
- Personal data in files or history: names beyond the author credit, emails, addresses, home layouts, photos, absolute home paths (−5 each, −20 cap). Search with:
  `git grep -nIiE 'gmail|@[a-z]+\.(com|co\.uk)|/Users/|/home/'` plus the untracked files.

**Security**
- Secrets: API keys, tokens, passwords, .env files, in files or history (−30).
- Every server, endpoint or middleware. For each, check:
  - Bound to localhost by default?
  - Cross-site requests refused (Origin/CSRF check)?
  - DNS rebinding blocked? Check the framework's host check runs *before* custom routes.
  - Input validated?
  - Request body size capped?
  - Subprocesses spawned without a shell, with arguments that can't inject flags?
  - Path traversal impossible?
  - Each gap: −3 to −15 depending on what it exposes.
- Anything spending the user's paid accounts (AI logins, cloud keys) that could be reached by someone else (−10 if reachable without opt-in).
- Unpinned or fragile external dependencies that could break or change behaviour silently (−3).

## 4. Report

Return exactly this shape:

```
README: NN%
Legality & security: NN%
Overall: NN%   (mean of the two)

README deductions:
- −N  <what>  (<file:line or "missing">)
...
Legality & security deductions:
- −N  <what>  (<file:line>)
...
Biggest wins: <the 3 cheapest fixes that add the most points>
```

Be strict and consistent: the same repo should get the same score from a fresh reviewer.
Don't give points back for good intentions. Only what is in the published files counts.
