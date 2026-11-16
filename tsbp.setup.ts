import fs from 'fs';
import Path from 'path';
import { spawnSync, execFileSync } from 'child_process';
import chalk from 'chalk';
import { confirm, input, number, select } from '@inquirer/prompts';
import sortPackageJson from 'sort-package-json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PackageManager = 'npm' | 'yarn' | 'pnpm';
export type ProjectType = 'Server' | 'Cronjob';
export type DependencyUpdates = 'dependabot' | 'renovate' | 'none';
export type License = 'UNLICENSED' | 'MIT' | 'ISC' | 'Apache-2.0' | 'BSD-3-Clause' | 'MPL-2.0' | 'GPL-3.0-only';

export interface Answers {
  projectName: string;
  packageManager: PackageManager;
  nodeMajor: number;
  /** false when the project doesn't need Docker */
  docker: false | ProjectType;
  semanticRelease: boolean;
  jasmine: boolean;
  codecov: boolean;
  sentry: boolean;
  updates: DependencyUpdates;
  zizmor: boolean;
  license: License;
  /** Copyright holder, only used when license !== 'UNLICENSED' */
  author: string;
}

export interface PackageInfo {
  version: string;
  /** engines.node of that version, if declared */
  nodeEngine?: string;
}

export interface Resolved {
  year: number;
  /** null when the image couldn't be resolved (e.g. offline) */
  nodeImage: { tag: string; digest: string } | null;
  /** Exact versions for every package returned by requiredPackages(). Missing entries fall back to 'latest'. */
  packages: Record<string, PackageInfo>;
  /** Newest @types/node for the chosen major, null when unresolved (the shipped version is kept) */
  typesNode: string | null;
}

export interface ApplyResult {
  secrets: string[];
  warnings: string[];
}

interface PackageJson {
  [key: string]: unknown;
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOILERPLATE = 'boilerplate';
const FALLBACK_NODE_MAJOR = 24;

export const LICENSES: { value: License; name: string }[] = [
  { value: 'UNLICENSED', name: 'UNLICENSED (proprietary, no LICENSE file)' },
  { value: 'MIT', name: 'MIT' },
  { value: 'ISC', name: 'ISC' },
  { value: 'Apache-2.0', name: 'Apache 2.0' },
  { value: 'BSD-3-Clause', name: 'BSD 3-Clause' },
  { value: 'MPL-2.0', name: 'Mozilla Public License 2.0' },
  { value: 'GPL-3.0-only', name: 'GNU GPL v3.0' }
];

/** devDependencies only needed to run this wizard; removed from package.json by apply(). */
const SETUP_ONLY_DEV_DEPENDENCIES = ['@inquirer/prompts', 'chalk', 'sort-package-json', 'tsx', '@types/npm', 'shx', 'replace-in-file'];

/** semantic-release plugins that ship with semantic-release itself and need no separate install. */
const SEMANTIC_RELEASE_BUNDLED = ['@semantic-release/commit-analyzer', '@semantic-release/release-notes-generator', '@semantic-release/npm', '@semantic-release/github'];
const SEMANTIC_RELEASE_STEPS = ['verifyConditions', 'analyzeCommits', 'verifyRelease', 'generateNotes', 'prepare', 'publish', 'addChannel', 'success', 'fail'];

const PM_PLACEHOLDERS: Record<PackageManager, Record<string, string>> = {
  npm: {
    __PM__: 'npm',
    __PM_INSTALL__: 'npm ci',
    __PM_INSTALL_PROD__: 'npm ci --omit=dev',
    __PM_RUN__: 'npm run',
    __PM_LOCKFILE__: 'package-lock.json'
  },
  yarn: {
    __PM__: 'yarn',
    __PM_INSTALL__: 'yarn install --immutable',
    __PM_INSTALL_PROD__: 'yarn workspaces focus --all --production',
    __PM_RUN__: 'yarn',
    __PM_LOCKFILE__: 'yarn.lock'
  },
  pnpm: {
    __PM__: 'pnpm',
    __PM_INSTALL__: 'pnpm install --frozen-lockfile',
    __PM_INSTALL_PROD__: 'pnpm install --frozen-lockfile --prod',
    __PM_RUN__: 'pnpm',
    __PM_LOCKFILE__: 'pnpm-lock.yaml'
  }
};

const JASMINE_COMMAND = 'jasmine --config=jasmine.config.json --require=tsx';

/** https://github.com/github/gitignore/blob/main/Node.gitignore (Yarn, non zero-install) */
const YARN_GITIGNORE = `
# Yarn (berry)
.pnp.*
.yarn/*
!.yarn/patches
!.yarn/plugins
!.yarn/releases
!.yarn/sdks
!.yarn/versions
`;

// ---------------------------------------------------------------------------
// Template engine
// ---------------------------------------------------------------------------

export const TEMPLATE_FLAGS = ['pm:npm', 'pm:yarn', 'pm:pnpm', 'pm:corepack', 'docker', 'jasmine', 'codecov', 'sentry', 'semantic-release', 'zizmor', 'dependabot', 'renovate'] as const;
export type TemplateFlag = typeof TEMPLATE_FLAGS[number];

export interface TemplateContext {
  flags: Record<TemplateFlag, boolean>;
  placeholders: Record<string, string>;
}

const MARKER = /^#\s*tsbp:(begin|end)\s+(!?[a-z][a-z:-]*)\s*$/;

/**
 * Resolves `# tsbp:begin <flag>` / `# tsbp:end <flag>` blocks (nestable, `!flag` negates) and then substitutes
 * placeholders. Throws on unknown flags, mismatched or unbalanced markers and malformed marker lines.
 */
export const renderTemplate = (text: string, context: TemplateContext, name = 'template'): string => {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const stack: { name: string; keep: boolean; line: number }[] = [];
  const output: string[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const match = MARKER.exec(trimmed);

    if (!match) {
      if (/^#\s*tsbp:/.test(trimmed)) {
        throw new Error(`${name}:${index + 1}: malformed tsbp marker "${trimmed}"`);
      }

      if (stack.every((block) => block.keep)) {
        output.push(line);
      }
      return;
    }

    const [, kind, flagExpression] = match;
    const negated = flagExpression.startsWith('!');
    const flag = (negated ? flagExpression.slice(1) : flagExpression) as TemplateFlag;

    if (!TEMPLATE_FLAGS.includes(flag)) {
      throw new Error(`${name}:${index + 1}: unknown tsbp flag "${flag}"`);
    }

    if (kind === 'begin') {
      stack.push({ name: flagExpression, keep: context.flags[flag] !== negated, line: index + 1 });
      return;
    }

    const open = stack.pop();
    if (!open) {
      throw new Error(`${name}:${index + 1}: "tsbp:end ${flagExpression}" without a matching begin`);
    }
    if (open.name !== flagExpression) {
      throw new Error(`${name}:${index + 1}: "tsbp:end ${flagExpression}" closes "tsbp:begin ${open.name}" from line ${open.line}`);
    }
  });

  if (stack.length > 0) {
    const open = stack[stack.length - 1];
    throw new Error(`${name}:${open.line}: "tsbp:begin ${open.name}" is never closed`);
  }

  let result = output.join(eol);
  for (const [placeholder, value] of Object.entries(context.placeholders)) {
    result = result.split(placeholder).join(value);
  }

  const leftover = /__PM_?[A-Z_]*__/.exec(result);
  if (leftover) {
    throw new Error(`${name}: unknown placeholder "${leftover[0]}"`);
  }

  return result;
};

export const buildTemplateContext = (answers: Answers, resolved: Resolved): TemplateContext => ({
  flags: {
    'pm:npm': answers.packageManager === 'npm',
    'pm:yarn': answers.packageManager === 'yarn',
    'pm:pnpm': answers.packageManager === 'pnpm',
    'pm:corepack': answers.packageManager !== 'npm',
    docker: answers.docker !== false,
    jasmine: answers.jasmine,
    codecov: answers.codecov,
    sentry: answers.sentry,
    'semantic-release': answers.semanticRelease,
    zizmor: answers.zizmor,
    dependabot: answers.updates === 'dependabot',
    renovate: answers.updates === 'renovate'
  },
  placeholders: {
    ...PM_PLACEHOLDERS[answers.packageManager],
    '%%PROJECTNAME%%': answers.projectName,
    __YEAR__: `${resolved.year}`,
    __AUTHOR__: answers.author
  }
});

/** Replaces every match of `pattern` in a file, the cross-platform equivalent of `sed -i`. Returns the number of replacements. */
export const replaceInFile = (path: string, pattern: RegExp, replacement: string): number => {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const original = fs.readFileSync(path, 'utf8');
  let count = 0;
  const updated = original.replace(global, () => {
    count++;
    return replacement;
  });

  if (count > 0) {
    fs.writeFileSync(path, updated);
  }

  return count;
};

/** Matches the pinned base image in the Dockerfile templates, e.g. node:24.11.1-alpine3.22@sha256:<digest> */
export const DOCKER_IMAGE_PATTERN = /node:[^\s@]+@sha256:[a-f0-9]{64}/;

// ---------------------------------------------------------------------------
// Network resolution (every function here degrades gracefully when offline)
// ---------------------------------------------------------------------------

const fetchWithTimeout = async (url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> => {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
};

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetchWithTimeout(url, init);
  if (!response.ok) {
    throw new Error(`${url} responded with ${response.status}`);
  }
  return await response.json() as T;
};

interface NodeRelease { version: string; lts: string | false }

let nodeReleasesCache: Promise<NodeRelease[]> | undefined;

/** All stable Node.js releases, newest first. */
const fetchNodeReleases = async (): Promise<NodeRelease[]> => {
  nodeReleasesCache ??= fetchJson<NodeRelease[]>('https://nodejs.org/dist/index.json')
    .then((releases) => releases.filter((release) => /^v\d+\.\d+\.\d+$/.test(release.version)));
  return nodeReleasesCache;
};

const majorOf = (version: string): number => Number(version.replace(/^v/, '').split('.')[0]);

/** Newest major that has an LTS release, or FALLBACK_NODE_MAJOR when nodejs.org can't be reached. */
export const resolveLtsMajor = async (): Promise<number> => {
  try {
    const lts = (await fetchNodeReleases()).find((release) => release.lts !== false);
    return lts ? majorOf(lts.version) : FALLBACK_NODE_MAJOR;
  } catch {
    return FALLBACK_NODE_MAJOR;
  }
};

const dockerManifestDigest = async (repository: string, tag: string, token: string): Promise<string | null> => {
  const response = await fetchWithTimeout(`https://registry-1.docker.io/v2/${repository}/manifests/${tag}`, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'
    }
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Docker Hub responded with ${response.status} for ${repository}:${tag}`);
  }

  return response.headers.get('docker-content-digest');
};

/**
 * Resolves the newest `node:<X.Y.Z>-alpine` image for a major, pinned to its multi-arch digest. Docker images can
 * lag a fresh Node release, so when the newest tag doesn't exist yet the previous releases are tried.
 */
export const resolveNodeImage = async (major: number): Promise<Resolved['nodeImage']> => {
  try {
    const candidates = (await fetchNodeReleases()).filter((release) => majorOf(release.version) === major).slice(0, 3);
    if (candidates.length === 0) {
      return null;
    }

    const { token } = await fetchJson<{ token: string }>('https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull');

    for (const candidate of candidates) {
      const tag = `${candidate.version.replace(/^v/, '')}-alpine`;
      const digest = await dockerManifestDigest('library/node', tag, token);
      if (digest && /^sha256:[a-f0-9]{64}$/.test(digest)) {
        return { tag, digest };
      }
    }

    return null;
  } catch {
    return null;
  }
};

/** Newest stable @types/node release within a major. The registry doesn't resolve ranges, so read the abbreviated packument. */
export const resolveTypesNode = async (major: number): Promise<string | null> => {
  try {
    const packument = await fetchJson<{ versions: Record<string, unknown> }>('https://registry.npmjs.org/@types%2Fnode', {
      headers: { Accept: 'application/vnd.npm.install-v1+json' }
    });
    const versions = Object.keys(packument.versions)
      .filter((version) => /^\d+\.\d+\.\d+$/.test(version) && majorOf(version) === major)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return versions.at(-1) ?? null;
  } catch {
    return null;
  }
};

/** Yarn (npmMinimalAgeGate) and pnpm (minimumReleaseAge) refuse or special-case releases younger than a day. */
const MINIMUM_RELEASE_AGE_MS = 24 * 60 * 60 * 1000;

const compareVersions = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/**
 * The newest stable version of each package that is no newer than `latest` and at least a day old.
 * Packages that can't be resolved are left out.
 */
export const resolvePackageVersions = async (names: string[]): Promise<Record<string, PackageInfo>> => {
  const cutoff = Date.now() - MINIMUM_RELEASE_AGE_MS;

  const entries = await Promise.all(names.map(async (name): Promise<[string, PackageInfo] | null> => {
    try {
      const packument = await fetchJson<{
        'dist-tags': { latest: string };
        time: Record<string, string>;
        versions: Record<string, { engines?: { node?: string }; deprecated?: string }>;
      }>(`https://registry.npmjs.org/${name.replace('/', '%2F')}`);
      const latest = packument['dist-tags'].latest;

      const version = Object.keys(packument.versions)
        .filter((candidate) => /^\d+\.\d+\.\d+$/.test(candidate) && !packument.versions[candidate].deprecated)
        .filter((candidate) => compareVersions(candidate, latest) <= 0 && Date.parse(packument.time[candidate] ?? '') <= cutoff)
        .sort(compareVersions)
        .at(-1) ?? latest;

      return [name, { version, nodeEngine: packument.versions[version]?.engines?.node }];
    } catch {
      return null;
    }
  }));

  return Object.fromEntries(entries.filter((entry): entry is [string, PackageInfo] => entry !== null));
};

/** Latest version of a package manager, used when corepack is unavailable. */
export const resolvePackageManagerVersion = async (packageManager: PackageManager): Promise<string | null> => {
  const registryName = { npm: 'npm', pnpm: 'pnpm', yarn: '@yarnpkg/cli-dist' }[packageManager];
  return (await resolvePackageVersions([registryName]))[registryName]?.version ?? null;
};

/** Packages the generated project needs on top of what tsbp ships, given the answers. */
export const requiredPackages = (answers: Answers, root = process.cwd()): { dependencies: string[]; devDependencies: string[] } => {
  const dependencies: string[] = [];
  const devDependencies: string[] = [];

  if (answers.jasmine) {
    devDependencies.push('jasmine', '@types/jasmine', 'eslint-plugin-jasmine');
  }

  if (answers.codecov) {
    devDependencies.push('c8');
  }

  if (answers.sentry) {
    // Runtime dependency: it has to survive the production install in the Docker image.
    dependencies.push('@sentry/node');
  }

  if (answers.semanticRelease) {
    devDependencies.push('semantic-release', ...semanticReleasePlugins(Path.join(root, BOILERPLATE, '.releaserc.json')));
  }

  return { dependencies, devDependencies };
};

/** Plugins (and conventional-changelog presets) referenced by .releaserc.json that semantic-release doesn't bundle. */
const semanticReleasePlugins = (releasercPath: string): string[] => {
  if (!fs.existsSync(releasercPath)) {
    return [];
  }

  const config = JSON.parse(fs.readFileSync(releasercPath, 'utf8')) as Record<string, unknown>;
  const packages = new Set<string>();

  const visit = (entry: unknown): void => {
    if (typeof entry === 'string') {
      packages.add(entry);
    } else if (Array.isArray(entry) && typeof entry[0] === 'string') {
      packages.add(entry[0]);
      const options = entry[1] as { preset?: unknown } | undefined;
      if (typeof options?.preset === 'string' && options.preset !== 'angular') {
        packages.add(`conventional-changelog-${options.preset}`);
      }
    }
  };

  (Array.isArray(config.plugins) ? config.plugins : []).forEach(visit);
  SEMANTIC_RELEASE_STEPS.forEach((step) => {
    const value = config[step];
    (Array.isArray(value) && typeof value[0] !== 'string' ? value : [value]).forEach(visit);
  });

  return [...packages].filter((name) => !SEMANTIC_RELEASE_BUNDLED.includes(name)).sort();
};

/** Everything that needs the network before files are written. */
export const resolve = async (answers: Answers, root = process.cwd()): Promise<Resolved> => {
  const { dependencies, devDependencies } = requiredPackages(answers, root);

  const [nodeImage, packages, typesNode] = await Promise.all([
    answers.docker ? resolveNodeImage(answers.nodeMajor) : Promise.resolve(null),
    resolvePackageVersions([...dependencies, ...devDependencies]),
    resolveTypesNode(answers.nodeMajor)
  ]);

  return { year: new Date().getFullYear(), nodeImage, packages, typesNode };
};

// ---------------------------------------------------------------------------
// File work
// ---------------------------------------------------------------------------

const readJson = <T>(path: string): T => JSON.parse(fs.readFileSync(path, 'utf8')) as T;

const detectIndent = (text: string): string => /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  ';

/** Applies answers to the repository at root. Does not touch the network or install anything. */
export const apply = (answers: Answers, resolved: Resolved, root = process.cwd()): ApplyResult => {
  const at = (...segments: string[]): string => Path.join(root, ...segments);
  const context = buildTemplateContext(answers, resolved);
  const secrets: string[] = [];
  const warnings: string[] = [];

  const copyTemplate = (source: string, destination: string): void => {
    const sourcePath = at(BOILERPLATE, source);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Template ${BOILERPLATE}/${source} is missing`);
    }
    fs.mkdirSync(Path.dirname(at(destination)), { recursive: true });
    fs.writeFileSync(at(destination), renderTemplate(fs.readFileSync(sourcePath, 'utf8'), context, `${BOILERPLATE}/${source}`));
  };

  const remove = (path: string): void => {
    fs.rmSync(at(path), { recursive: true, force: true });
  };

  // GitHub workflows
  copyTemplate('.github/workflows/checks.yml', '.github/workflows/checks.yml');

  if (answers.semanticRelease) {
    copyTemplate('.github/workflows/release.yml', '.github/workflows/release.yml');
    copyTemplate('.releaserc.json', '.releaserc.json');
    secrets.push('NPM_TOKEN');
  }

  if (answers.zizmor) {
    copyTemplate('.github/workflows/zizmor.yml', '.github/workflows/zizmor.yml');
  }

  // Dependency updates
  switch (answers.updates) {
    case 'dependabot':
      copyTemplate('.github/dependabot.yml', '.github/dependabot.yml');
      copyTemplate('.github/workflows/dependabot-automerge.yml', '.github/workflows/dependabot-automerge.yml');
      break;
    case 'renovate':
      copyTemplate('renovate.json', 'renovate.json');
      remove('.github/dependabot.yml');
      break;
    case 'none':
      remove('.github/dependabot.yml');
      break;
  }

  // Docker
  if (answers.docker) {
    if (answers.docker === 'Server') {
      copyTemplate('aserver.dockerfile', 'Dockerfile');
    } else {
      copyTemplate('acron.dockerfile', 'Dockerfile');
      copyTemplate('PROJECTNAME-cron', `${answers.projectName}-cron`);
    }
    copyTemplate('.dockerignore', '.dockerignore');

    const image = resolved.nodeImage
      ? `node:${resolved.nodeImage.tag}@${resolved.nodeImage.digest}`
      : `node:${answers.nodeMajor}-alpine`;

    if (!resolved.nodeImage) {
      warnings.push(`Could not resolve a pinned node:${answers.nodeMajor}-alpine image from Docker Hub, the Dockerfile uses the floating tag node:${answers.nodeMajor}-alpine instead.`);
    }

    if (replaceInFile(at('Dockerfile'), DOCKER_IMAGE_PATTERN, image) === 0) {
      warnings.push('The Dockerfile has no pinned node image to replace, check its FROM line.');
    }
  }

  // Package manager
  if (answers.packageManager === 'yarn') {
    copyTemplate('.yarnrc.yml', '.yarnrc.yml');
    if (fs.existsSync(at('.gitignore'))) {
      fs.appendFileSync(at('.gitignore'), YARN_GITIGNORE);
    }
  }

  if (answers.packageManager === 'pnpm') {
    // pnpm fails installs on unapproved build scripts; esbuild (a dependency of tsx) has one
    fs.writeFileSync(at('pnpm-workspace.yaml'), 'allowBuilds:\n  esbuild: true\n');
  }

  // License
  if (answers.license === 'UNLICENSED') {
    remove('LICENSE');
  } else {
    copyTemplate(`licenses/${answers.license}.txt`, 'LICENSE');
  }

  // Jasmine
  if (answers.jasmine) {
    copyTemplate('jasmine.config.json', 'jasmine.config.json');
    copyTemplate('index.spec.ts', 'test/index.spec.ts');

    // Add linting for Jasmine, courtesy of https://github.com/tlvince/eslint-plugin-jasmine (no flat preset, so take its rules)
    fs.writeFileSync(at('eslint.config.mjs'), [
      'import fdebijlConfig from \'@fdebijl/eslint-config\';',
      'import jasmine from \'eslint-plugin-jasmine\';',
      '',
      'export default [',
      '  ...fdebijlConfig,',
      '  {',
      '    files: [\'test/**/*.ts\'],',
      '    plugins: { jasmine },',
      '    rules: jasmine.configs.recommended.rules',
      '  }',
      '];',
      ''
    ].join('\n'));

    // tsconfig only includes src/, specs are run by tsx; the jasmine types are for editor support
    const tsconfig = readJson<{ compilerOptions?: { types?: string[] } & Record<string, unknown> }>(at('tsconfig.json'));
    tsconfig.compilerOptions = { ...tsconfig.compilerOptions, types: [...new Set([...(tsconfig.compilerOptions?.types ?? ['node']), 'jasmine'])] };
    fs.writeFileSync(at('tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`);
  }

  if (answers.codecov) {
    secrets.push('CODECOV_TOKEN');
  }

  if (answers.sentry) {
    secrets.push('SENTRY_DSN', 'SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT');
  }

  // Node version, read by the workflows (node-version-file) and nvm/fnm/volta
  fs.writeFileSync(at('.nvmrc'), `${answers.nodeMajor}\n`);

  warnings.push(...updatePackageJson(answers, resolved, at('package.json'), root));

  if (secrets.length > 0) {
    fs.writeFileSync(at('example.env'), `${secrets.map((secret) => `${secret}=PLACEHOLDER`).join('\n')}\n`);
  }

  fs.writeFileSync(at('README.md'), `# ${answers.projectName}\n\n*Enter a short description for the project here.*\n`);

  // The wizard removes itself
  remove(BOILERPLATE);
  remove('tsbp.setup.ts');

  return { secrets, warnings };
};

const updatePackageJson = (answers: Answers, resolved: Resolved, path: string, root: string): string[] => {
  const warnings: string[] = [];
  const raw = fs.readFileSync(path, 'utf8');
  const packageJson = JSON.parse(raw) as PackageJson;
  const run = PM_PLACEHOLDERS[answers.packageManager].__PM_RUN__;

  packageJson.name = answers.projectName;
  packageJson.license = answers.license;
  packageJson.engines = { node: `>=${answers.nodeMajor}` };

  delete packageJson.scripts.presetup;
  delete packageJson.scripts.setup;
  delete packageJson.scripts.postsetup;

  const keepTsx = answers.jasmine;
  packageJson.devDependencies = Object.fromEntries(Object.entries(packageJson.devDependencies ?? {})
    .filter(([name]) => !SETUP_ONLY_DEV_DEPENDENCIES.includes(name) || (keepTsx && name === 'tsx')));

  if (answers.jasmine) {
    packageJson.scripts.test = JASMINE_COMMAND;
    packageJson.scripts.lint = 'eslint "./src/**/*.ts" "./test/**/*.ts" --max-warnings 10';
  }

  if (answers.codecov) {
    packageJson.scripts['test:coverage'] = `c8 --reporter=lcov --reporter=text ${JASMINE_COMMAND}`;
  }

  if (answers.semanticRelease) {
    delete packageJson.private;
    packageJson.version = '1.0.0';
    packageJson.description = 'Placeholder description';
    packageJson.main = 'dist/index.js';
    packageJson.types = 'dist/index.d.ts';
    packageJson.files = ['dist/**/*'];
    packageJson.publishConfig = {
      access: 'public',
      registry: 'https://registry.npmjs.org/'
    };
    packageJson.scripts.prepare = `${run} compile`;
    packageJson.scripts.semanticrelease = 'semantic-release';
  }

  const { dependencies, devDependencies } = requiredPackages(answers, root);
  const versionOf = (name: string): string => {
    const info = resolved.packages[name];
    if (!info) {
      warnings.push(`Could not resolve the latest version of ${name}, it was added as "latest". Pin it after installing.`);
      return 'latest';
    }

    const minimumNode = /^>=\s*(\d+)/.exec(info.nodeEngine ?? '');
    if (minimumNode && Number(minimumNode[1]) > answers.nodeMajor) {
      warnings.push(`${name}@${info.version} requires Node ${info.nodeEngine}, but this project targets Node ${answers.nodeMajor}.`);
    }

    return info.version;
  };

  if (dependencies.length > 0) {
    packageJson.dependencies = { ...packageJson.dependencies };
    dependencies.forEach((name) => { packageJson.dependencies![name] = versionOf(name); });
  }
  devDependencies.forEach((name) => { packageJson.devDependencies![name] = versionOf(name); });

  if (resolved.typesNode) {
    packageJson.devDependencies!['@types/node'] = resolved.typesNode;
  } else {
    warnings.push(`Could not resolve @types/node for Node ${answers.nodeMajor}, align it with .nvmrc manually.`);
  }

  const sorted = sortPackageJson(packageJson);
  fs.writeFileSync(path, `${JSON.stringify(sorted, null, detectIndent(raw))}\n`);

  return warnings;
};

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/** The environment for the package manager, without the npm_* variables leaking in from `npm run setup`. */
const installEnvironment = (): NodeJS.ProcessEnv => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)));
  return {
    ...env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    // Yarn refuses to create a lockfile on CI by default
    YARN_ENABLE_IMMUTABLE_INSTALLS: 'false'
  };
};

const runCommand = (command: string, args: string[], root: string): boolean => {
  console.log(chalk.dim(`$ ${command} ${args.join(' ')}`));
  const result = spawnSync(command, args, {
    cwd: root,
    env: installEnvironment(),
    stdio: 'inherit',
    // .cmd shims on Windows can only be started through a shell
    shell: process.platform === 'win32'
  });
  return !result.error && result.status === 0;
};

export interface InstallResult {
  installed: boolean;
  packageManagerField: string | null;
}

/**
 * Pins the chosen package manager in package.json (`packageManager`) and installs dependencies with it through
 * corepack, which produces the right lockfile. Falls back to writing an unhashed `packageManager` field when corepack
 * can't be used, in which case the user has to install manually.
 */
export const install = async (answers: Answers, root = process.cwd()): Promise<InstallResult> => {
  const at = (...segments: string[]): string => Path.join(root, ...segments);
  const pm = answers.packageManager;

  if (pm !== 'npm') {
    for (const path of ['package-lock.json', 'node_modules']) {
      try {
        fs.rmSync(at(path), { recursive: true, force: true });
      } catch (error) {
        console.log(chalk.yellow(`Could not remove ${path}: ${(error as Error).message}`));
      }
    }
  }

  if (pm === 'yarn' && !fs.existsSync(at('yarn.lock'))) {
    // Anchors the Yarn project root here, rather than in a parent directory
    fs.writeFileSync(at('yarn.lock'), '');
  }

  const readPackageManagerField = (): string | null => (readJson<{ packageManager?: string }>(at('package.json')).packageManager ?? null);

  if (runCommand('corepack', ['use', `${pm}@latest`], root) || runCommand('npx', ['--yes', 'corepack@latest', 'use', `${pm}@latest`], root)) {
    return { installed: true, packageManagerField: readPackageManagerField() };
  }

  const version = await resolvePackageManagerVersion(pm);
  if (version) {
    const path = at('package.json');
    const raw = fs.readFileSync(path, 'utf8');
    const packageJson = JSON.parse(raw) as PackageJson;
    packageJson.packageManager = `${pm}@${version}`;
    fs.writeFileSync(path, `${JSON.stringify(sortPackageJson(packageJson), null, detectIndent(raw))}\n`);
  }

  return { installed: false, packageManagerField: readPackageManagerField() };
};

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export interface AskDefaults {
  projectName: string;
  nodeMajor: number;
  author: string;
  /** Licenses whose template has a copyright line (__AUTHOR__); only these ask for a copyright holder */
  licensesWithHolder: License[];
}

/** Only gathers answers, never touches the file system. */
export const ask = async (defaults: AskDefaults): Promise<Answers> => {
  const projectName = (await input({
    message: 'Project name (used in package.json, the Dockerfile and the cronjob):',
    default: defaults.projectName,
    validate: (value) => /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(value.trim().toLowerCase()) || 'Use a valid npm package name (lowercase, no spaces)'
  })).trim().toLowerCase();

  const packageManager = await select<PackageManager>({
    message: 'Package manager:',
    choices: [
      { value: 'npm', name: 'npm' },
      { value: 'yarn', name: 'Yarn (berry, node_modules linker)' },
      { value: 'pnpm', name: 'pnpm' }
    ],
    default: 'npm'
  });

  const nodeMajor = await number({
    message: 'Node.js major version:',
    default: defaults.nodeMajor,
    min: 18,
    max: 99,
    required: true
  });

  const needsDocker = await confirm({ message: 'Does this project need Docker? (Containerisation)' });
  let docker: Answers['docker'] = false;
  if (needsDocker) {
    docker = await select<ProjectType>({
      message: 'How should the container run?',
      choices: [
        { value: 'Server', name: 'Server', description: 'Run the main file until it crashes or exits' },
        { value: 'Cronjob', name: 'Cronjob', description: 'A task that is repeated every X minutes' }
      ]
    });
  }

  const semanticRelease = docker
    ? false
    : await confirm({ message: 'Does this project need Semantic Release? (Automatic releases to npm)', default: false });

  const jasmine = await confirm({ message: 'Does this project need Jasmine? (Unit testing)' });
  const codecov = jasmine
    ? await confirm({ message: 'Does this project need Codecov? (Test coverage reporting)' })
    : false;
  const sentry = await confirm({ message: 'Does this project need Sentry? (Error reporting)', default: false });

  const updates = await select<DependencyUpdates>({
    message: 'Automatic dependency updates:',
    choices: [
      { value: 'dependabot', name: 'Dependabot', description: 'Weekly updates, patch and minor PRs are auto-merged once checks pass' },
      { value: 'renovate', name: 'Renovate', description: 'Requires the Renovate GitHub app' },
      { value: 'none', name: 'No automatic updates' }
    ],
    default: 'dependabot'
  });

  const zizmor = await confirm({ message: 'Audit GitHub workflows with zizmor? (Workflow security linting)', default: true });

  const license = await select<License>({
    message: 'License:',
    choices: LICENSES,
    default: 'UNLICENSED'
  });

  const author = !defaults.licensesWithHolder.includes(license)
    ? defaults.author
    : (await input({ message: 'Copyright holder for the LICENSE:', default: defaults.author || undefined, required: true })).trim();

  return { projectName, packageManager, nodeMajor, docker, semanticRelease, jasmine, codecov, sentry, updates, zizmor, license, author };
};

const gitUserName = (): string => {
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const summarise = (answers: Answers): string => [
  ['Project name', answers.projectName],
  ['Package manager', answers.packageManager],
  ['Node.js', `${answers.nodeMajor}`],
  ['Docker', answers.docker || 'no'],
  ['Semantic Release', answers.semanticRelease ? 'yes' : 'no'],
  ['Jasmine', answers.jasmine ? 'yes' : 'no'],
  ['Codecov', answers.codecov ? 'yes' : 'no'],
  ['Sentry', answers.sentry ? 'yes' : 'no'],
  ['Dependency updates', answers.updates],
  ['zizmor', answers.zizmor ? 'yes' : 'no'],
  ['License', answers.license],
  ['Copyright holder', answers.author]
].map(([key, value]) => `  ${chalk.dim(key.padEnd(20))}${value}`).join('\n');

export const nextSteps = (answers: Answers, result: ApplyResult, installResult: InstallResult): string[] => {
  const pm = answers.packageManager;
  const run = PM_PLACEHOLDERS[pm].__PM_RUN__;
  const steps: string[] = [];

  if (!installResult.installed) {
    steps.push(installResult.packageManagerField
      ? `Install dependencies: run \`corepack enable\` (or \`npm i -g corepack\` on Node >= 25), then \`${pm} install\`. package.json pins ${installResult.packageManagerField} without an integrity hash; \`corepack use ${installResult.packageManagerField}\` adds it.`
      : `Install dependencies: run \`corepack use ${pm}@latest\` (or \`npx corepack@latest use ${pm}@latest\`).`);
  }

  if (result.secrets.length > 0) {
    steps.push(`Add these secrets to the GitHub repository (Settings > Secrets and variables > Actions) and/or your .env (see example.env): ${result.secrets.join(', ')}`);
  }

  if (answers.updates === 'dependabot') {
    steps.push('Enable "Allow auto-merge" in the repository settings (Settings > General), and require the PR Checks jobs in a branch ruleset for the default branch, otherwise Dependabot PRs are merged without waiting for checks.');
  } else if (answers.updates === 'renovate') {
    steps.push('Install the Renovate GitHub app (https://github.com/apps/renovate) on this repository.');
  }

  if (answers.semanticRelease) {
    steps.push('Fill in the description in package.json and write Conventional Commits (feat:, fix:, ...) so semantic-release can version releases.');
  }

  if (answers.docker) {
    steps.push(`Build the image with \`docker build -t ${answers.projectName} .\``);
  }

  if (answers.license !== 'UNLICENSED') {
    steps.push(`Review LICENSE (${answers.license}).`);
  }

  steps.push(`Try it out with \`${run} compile\`${answers.jasmine ? ` and \`${pm} test\`` : ''}, then commit the result.`);

  return steps;
};

const init = async (): Promise<void> => {
  const root = process.cwd();
  console.log(chalk.green('Fdebijl\'s TypeScript BoilerPlate Setup\n'));

  const answers = await ask({
    projectName: Path.basename(root).toLowerCase().replace(/[^a-z0-9-._~]/g, '-'),
    nodeMajor: await resolveLtsMajor(),
    author: gitUserName(),
    licensesWithHolder: LICENSES.map(({ value }) => value).filter((license) => {
      const template = Path.join(root, BOILERPLATE, 'licenses', `${license}.txt`);
      return fs.existsSync(template) && fs.readFileSync(template, 'utf8').includes('__AUTHOR__');
    })
  });

  console.log(`\n${summarise(answers)}\n`);
  if (!await confirm({ message: 'Apply these choices? This rewrites the repository and removes the setup wizard.' })) {
    console.log(chalk.yellow('Nothing was changed.'));
    return;
  }

  console.log(chalk.blue('\nResolving versions...'));
  const resolved = await resolve(answers, root);

  console.log(chalk.blue('Writing files...'));
  const result = apply(answers, resolved, root);

  console.log(chalk.blue(`Installing dependencies with ${answers.packageManager}...`));
  const installResult = await install(answers, root);

  console.log(chalk.green('\nSetup finished.'));

  result.warnings.forEach((warning) => console.log(chalk.yellow(`Warning: ${warning}`)));

  console.log(chalk.green('\nNext steps:'));
  nextSteps(answers, result, installResult).forEach((step, index) => console.log(`${index + 1}. ${step}`));
};

if (require.main === module) {
  init().catch((error: Error) => {
    if (error.name === 'ExitPromptError') {
      console.log(chalk.yellow('\nSetup cancelled, nothing was changed.'));
      return;
    }
    console.error(chalk.red(error.stack ?? error.message));
    process.exitCode = 1;
  });
}
