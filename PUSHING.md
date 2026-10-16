# Pushing to BambooKit repositories

Two errors stop `git push` in this repository. This page explains both and how to fix them.

## 1. `This script requires bun@^1.3.14, but you are using bun@1.3.6`

```
error: This script requires bun@^1.3.14, but you are using bun@1.3.6
husky - pre-push script failed (code 1)
error: failed to push some refs to 'https://github.com/BambooKit/bambookit-application.git'
```

**What it is:** a check on your computer, not GitHub. Before every push, `.husky/pre-push` typechecks the whole
repository with the bun version pinned in `package.json` (`"packageManager": "bun@1.3.14"`).

**Fixed in the hook:** an older bun no longer blocks the push. The hook now prints a notice and runs the check with
`npx bun@1.3.14` instead, so the push goes through (the first time it downloads bun, about 30 MB).

**Permanent fix**, which also makes pushes faster: install the pinned version.

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
exec $SHELL          # reload the shell
bun --version        # 1.3.14
```

Use that exact version rather than `bun upgrade`. `bun upgrade` installs the newest bun, which may be a version the
repository has not been tested with.

The check takes about a minute (30 packages). Don't skip it with `git push --no-verify`; it catches type errors
before they reach `main`.

## 2. `Permission to BambooKit/<repo>.git denied to <account>` (HTTP 403)

```
remote: Permission to BambooKit/bambookit-application.git denied to JayashBhandary.
fatal: unable to access 'https://github.com/BambooKit/bambookit-application.git/': The requested URL returned error: 403
```

**What it is:** GitHub refused the push. The account saved on this computer can read the repository but has no
write access to the **BambooKit** organization. Nothing is wrong with the code.

**Fix, option A: give the account access** (an owner of the BambooKit organization does this)

1. Go to <https://github.com/orgs/BambooKit/people> and click **Invite member**.
2. Invite the account from the error (for example `JayashBhandary`).
   - Role **Member** with write access to the repositories you need, or
   - Role **Owner** if the account must also create repositories (for example `bambookit-mac`) and edit secrets.
3. Accept the invitation from that account's email or <https://github.com/orgs/BambooKit/invitation>.
4. Push again. No other change is needed; the saved login now has access.

**Fix, option B: push with an account that already has access**

```bash
gh auth login            # choose GitHub.com, HTTPS, and sign in in the browser as that account
gh auth setup-git        # make git use this login for github.com
git push origin main
```

If `gh` is not installed: <https://cli.github.com>, or download it from <https://github.com/cli/cli/releases>.

**Check which account git uses:**

```bash
gh auth status
git config --get credential.helper              # osxkeychain on macOS
git credential-osxkeychain erase <<< $'protocol=https\nhost=github.com\n'   # forget a saved login on macOS
```

On Windows, saved logins are under **Credential Manager → Windows Credentials → git:https://github.com**.

## 3. `repository not found`

```
remote: Repository not found.
fatal: repository 'https://github.com/BambooKit/bambookit-mac.git/' not found
```

The repository does not exist yet, or it is private and the saved account cannot see it. Create it (organization
owners only), or get access as in section 2:

```bash
gh repo create BambooKit/bambookit-mac --public
```

## What a push does here

| Repository | After a push to `main` |
| :--- | :--- |
| `bambookit-application` | Nothing deploys. A `v*` tag runs `.github/workflows/release-desktop.yml`, which builds and publishes Windows, Linux and macOS. |
| `bambookit-web` | Render rebuilds and deploys the website (`npm ci && npm run build`). |
| `bambookit-api` | Render redeploys the API. |
| `bambookit-mac` | Nothing deploys. macOS installers are published as its GitHub Releases. |

For desktop releases from the workflow, add these repository secrets to `bambookit-application`
(**Settings → Secrets and variables → Actions**):

- `BAMBOOKIT_SUPABASE_URL` and `BAMBOOKIT_SUPABASE_ANON_KEY`: the public sign-in config.
- `MAC_RELEASE_TOKEN`: a fine-grained token with **Contents: read and write** on `BambooKit/bambookit-mac`.
