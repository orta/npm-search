import sizeof from 'object-sizeof';
import NicePackage from 'nice-package';
import gravatarUrl from 'gravatar-url';
import numeral from 'numeral';
const defaultGravatar = 'https://www.gravatar.com/avatar/';
import escape from 'escape-html';
import traverse from 'traverse';
import truncate from 'truncate-utf8-bytes';
import hostedGitInfo from 'hosted-git-info';

import c from './config';

export default function formatPkg(pkg) {
  const cleaned = new NicePackage(pkg);
  if (!cleaned.name) {
    return undefined;
  }

  const lastPublisher = cleaned.lastPublisher
    ? formatUser(cleaned.lastPublisher)
    : null;
  const author = getAuthor(cleaned);
  const license = getLicense(cleaned);

  const version = cleaned.version ? cleaned.version : '0.0.0';
  const versions = getVersions(cleaned);
  const githubRepo = cleaned.repository
    ? getGitHubRepoInfo({
        repository: cleaned.repository,
        gitHead: cleaned.gitHead,
      })
    : null;

  if (!githubRepo && !lastPublisher && !author) {
    return undefined; // ignore this package, we cannot link it to anyone
  }

  const defaultRepository =
    typeof cleaned.repository === 'string'
      ? { url: cleaned.repository }
      : cleaned.repository;
  // If defaultRepository is undefined or it does not have an URL
  // we don't include it.
  const repository =
    defaultRepository && defaultRepository.url
      ? {
          ...defaultRepository, // Default info: type, url
          ...getRepositoryInfo(cleaned.repository), // Extra info: host, project, user...
          head: cleaned.gitHead,
          branch: cleaned.gitHead || 'master',
        }
      : null;

  const owner = getOwner(repository, lastPublisher, author); // always favor the repository owner
  const { computedKeywords, computedMetadata } = getComputedData(cleaned);
  const keywords = getKeywords(cleaned);

  const dependencies = cleaned.dependencies || {};
  const devDependencies = cleaned.devDependencies || {};
  const concatenatedName = cleaned.name.replace(/[-/@_.]+/g, '');
  const splitName = cleaned.name.replace(/[-/@_.]+/g, ' ');

  const tags = pkg['dist-tags'];
  const rawPkg = {
    objectID: cleaned.name,
    name: cleaned.name,
    downloadsLast30Days: 0,
    downloadsRatio: 0,
    humanDownloadsLast30Days: numeral(0).format('0.[0]a'),
    popular: false,
    version,
    versions,
    tags,
    description: cleaned.description ? cleaned.description : null,
    dependencies,
    devDependencies,
    originalAuthor: cleaned.author,
    repository,
    githubRepo,
    gitHead: githubRepo && githubRepo.head, // remove this when we update to the new schema frontend
    readme: pkg.readme,
    owner,
    deprecated: cleaned.deprecated !== undefined ? cleaned.deprecated : false,
    homepage: getHomePage(cleaned.homepage, cleaned.repository),
    license,
    keywords,
    computedKeywords,
    computedMetadata,
    created: Date.parse(cleaned.created),
    modified: Date.parse(cleaned.modified),
    lastPublisher,
    owners: (cleaned.owners || []).map(formatUser),
    bin: cleaned.bin,
    lastCrawl: new Date().toISOString(),
    _searchInternal: {
      concatenatedName,
      alternativeNames: [concatenatedName, splitName, cleaned.name],
    },
  };

  const totalSize = sizeof(rawPkg);
  if (totalSize > c.maxObjSize) {
    const sizeDiff = sizeof(rawPkg.readme) - totalSize;
    rawPkg.readme = `${truncate(
      rawPkg.readme,
      c.maxObjSize - sizeDiff
    )} **TRUNCATED**`;
  }

  return traverse(rawPkg).forEach(maybeEscape);
}

function maybeEscape(node) {
  if (this.isLeaf && typeof node === 'string') {
    if (this.key === 'readme') {
      this.update(node);
    } else {
      this.update(escape(node));
    }
  }
}

function getAuthor(cleaned) {
  if (cleaned.author && typeof cleaned.author === 'object') {
    return formatUser(cleaned.author);
  }
  if (Array.isArray(cleaned.owners) && typeof cleaned.owners[0] === 'object') {
    return formatUser(cleaned.owners[0]);
  }
  return null;
}

function getLicense(cleaned) {
  if (cleaned.license) {
    if (
      typeof cleaned.license === 'object' &&
      typeof cleaned.license.type === 'string'
    ) {
      return cleaned.license.type;
    }
    if (typeof cleaned.license === 'string') {
      return cleaned.license;
    }
  }
  return null;
}

function getOwner(repository, lastPublisher, author) {
  if (repository && repository.user) {
    const { user } = repository;

    if (repository.host === 'github.com') {
      return {
        name: user,
        avatar: `https://github.com/${user}.png`,
        link: `https://github.com/${user}`,
      };
    }

    if (repository.host === 'gitlab.com') {
      return {
        name: user,
        avatar: lastPublisher && lastPublisher.avatar,
        link: `https://gitlab.com/${user}`,
      };
    }

    if (repository.host === 'bitbucket.org') {
      return {
        name: user,
        avatar: `https://bitbucket.org/account/${user}/avatar`,
        link: `https://bitbucket.org/${user}`,
      };
    }
  }

  if (lastPublisher) {
    return lastPublisher;
  }

  return author;
}

function getGravatar(obj) {
  if (
    !obj.email ||
    typeof obj.email !== 'string' ||
    obj.email.indexOf('@') === -1
  ) {
    return defaultGravatar;
  }

  return gravatarUrl(obj.email);
}

function getVersions(cleaned) {
  if (cleaned.other && cleaned.other.time) {
    return Object.keys(cleaned.other.time)
      .filter(key => !['modified', 'created'].includes(key))
      .reduce(
        (obj, key) => ({
          ...obj,
          [key]: cleaned.other.time[key],
        }),
        {}
      );
  }
  return {};
}

const registrySubsetRules = [
  ({ name }) => ({
    name: 'babel-plugin',
    include:
      name.startsWith('@babel/plugin') || name.startsWith('babel-plugin-'),
  }),

  ({ name }) => ({
    name: 'vue-cli-plugin',
    include: /^(@vue\/|vue-|@[\w-]+\/vue-)cli-plugin-/.test(name),
  }),

  ({ name, keywords = [] }) => ({
    name: 'yeoman-generator',
    include:
      name.startsWith('generator-') && keywords.includes('yeoman-generator'),
  }),

  ({ schematics = '' }) => ({
    name: 'angular-cli-schematic',
    include: schematics.length > 0,
    metadata: { schematics },
  }),

  ({ name }) => ({
    name: 'webpack-scaffold',
    include: name.startsWith('webpack-scaffold-'),
  }),
];

function getComputedData(cleaned) {
  const registrySubsets = registrySubsetRules.reduce(
    (acc, matcher) => {
      const { include, metadata, name } = matcher(cleaned);
      return include
        ? {
            computedKeywords: [...acc.computedKeywords, name],
            computedMetadata: {
              ...acc.computedMetadata,
              ...metadata,
            },
          }
        : acc;
    },
    { computedKeywords: [], computedMetadata: {} }
  );
  return registrySubsets;
}

function getKeywords(cleaned) {
  if (cleaned.keywords) {
    if (Array.isArray(cleaned.keywords)) {
      return [...cleaned.keywords];
    }
    if (typeof cleaned.keywords === 'string') {
      return [cleaned.keywords];
    }
  }
  return [];
}

function getGitHubRepoInfo({ repository, gitHead = 'master' }) {
  if (!repository || typeof repository !== 'string') return null;

  const result = repository.match(
    /^https:\/\/(?:www\.)?github.com\/([^/]+)\/([^/]+)(\/.+)?$/
  );

  if (!result) {
    return null;
  }

  if (result.length < 3) {
    return null;
  }

  const head = gitHead;
  const [, user, project, path = ''] = result;

  return {
    user,
    project,
    path,
    head,
  };
}

function getHomePage(homepage, repository) {
  if (
    homepage &&
    typeof homepage === 'string' && // if there's a homepage
    (!repository || // and there's no repo,
    typeof repository !== 'string' || // or repo is not a string
      homepage.indexOf(repository) < 0) // or repo is different than homepage
  ) {
    return homepage; // then we consider it a valuable homepage
  }

  return null;
}

/**
 * Get info from urls like this: (has multiple packages in one repo, like babel does)
 *  https://github.com/babel/babel/tree/master/packages/babel
 *  https://gitlab.com/user/repo/tree/master/packages/project1
 *  https://bitbucket.org/user/repo/src/ae8df4cd0e809a789e3f96fd114075191c0d5c8b/packages/project1/
 *
 * This function is like getGitHubRepoInfo (above), but support github, gitlab and bitbucket.
 */
function getRepositoryInfoFromHttpUrl(repository) {
  const result = repository.match(
    /^https?:\/\/(?:www\.)?((?:github|gitlab|bitbucket)).((?:com|org))\/([^/]+)\/([^/]+)(\/.+)?$/
  );

  if (!result || result.length < 6) {
    return null;
  }

  const [, domain, domainTld, user, project, path = ''] = result;

  return {
    host: `${domain}.${domainTld}`,
    user,
    project,
    path,
  };
}

function getRepositoryInfo(repository) {
  if (!repository) {
    return null;
  }

  const url = typeof repository === 'string' ? repository : repository.url;
  const path = typeof repository === 'string' ? '' : repository.directory || '';

  if (!url) {
    return null;
  }

  /**
   * Get information using hosted-git-info.
   */
  const repositoryInfo = hostedGitInfo.fromUrl(url);

  if (repositoryInfo) {
    const { project, user, domain } = repositoryInfo;
    return {
      project,
      user,
      host: domain,
      path: path.replace(/^[./]+/, ''),
    };
  }

  /**
   * Unfortunately, hosted-git-info can't handle URL like this: (has path)
   *   https://github.com/babel/babel/tree/master/packages/babel-core
   * so we need to do it
   */
  const repositoryInfoFromUrl = getRepositoryInfoFromHttpUrl(url);
  if (!repositoryInfoFromUrl) {
    return null;
  }
  return {
    ...repositoryInfoFromUrl,
    path: path.replace(/^[./]+/, '') || repositoryInfoFromUrl.path,
  };
}

function formatUser(user) {
  return {
    ...user,
    avatar: getGravatar(user),
    link: `https://www.npmjs.com/~${encodeURIComponent(user.name)}`,
  };
}
