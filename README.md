# TypeScript BoilerPlate
A small boilerplate I use for personal TS projects 📝

Go [here](https://github.com/Fdebijl/tsbp/generate) to generate a new repo based on this boilerplate, or click the 'Use this template' button above.

Once you've cloned or downloaded the repo, run `npm run setup` to set up the project. The wizard asks:

1. **Project name**, used in package.json, the Dockerfile and the cronjob. Defaults to the directory name.
2. **Package manager**: npm (default), Yarn or pnpm. The chosen manager is pinned in `packageManager` through corepack and installs the dependencies at the end of setup.
3. **Node.js major version**, defaults to the current LTS. Written to `.nvmrc` (which the workflows read) and `engines.node`.
4. **Docker**, and if so whether the container runs as a **server** or a **cronjob**. The Dockerfile's base image is pinned to the latest `node:<version>-alpine` digest for that major.
5. **Semantic Release** (only without Docker): automatic releases to npm with a release workflow.
6. **Jasmine** for unit tests (run through tsx), and if so **Codecov** for coverage (collected with c8).
7. **Sentry** for error reporting.
8. **Automatic dependency updates**: Dependabot (default, with auto-merge for passing patch and minor updates), Renovate, or none.
9. **zizmor**, a workflow that audits the GitHub Actions workflows for security issues.
10. **License**: UNLICENSED (default), MIT, ISC, Apache 2.0, BSD 3-Clause, MPL 2.0 or GPL 3.0, plus the copyright holder (defaults to `git config user.name`).

After a final confirmation the wizard writes the files, resolves exact versions for the packages it adds, removes itself together with the `boilerplate` folder and its own dependencies, installs everything and prints the remaining manual steps (repository secrets, enabling auto-merge, etc.).
