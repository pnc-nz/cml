const fetch = require('node-fetch');
const { URL } = require('url');
const { ProxyAgent } = require('proxy-agent');
const { logger } = require('../logger');

const { fetchUploadData } = require('../utils');

const {
  BUILD_REPOSITORY_URI,
  SYSTEM_COLLECTIONURI,
  BUILD_REPOSITORY_ID,
  SYSTEM_PULLREQUEST_PULLREQUESTID,
  BUILD_SOURCEVERSION,
  BUILD_SOURCEBRANCH,
  BUILD_BUILDID,
  SYSTEM_DEFINITIONID
} = process.env;

const API_VER = '7.1';
const MAX_COMMENT_SIZE = 1000000;
const ERROR_COMMENT_SIZE =
  'Azure DevOps Comment is too large, this is likely caused by the `--publish-native` flag causing the comment to pass the 1M character limit';

class AzureDevOps {
  constructor(opts = {}) {
    const { repo, token } = opts;

    if (!token) throw new Error('token not found');
    if (!repo) throw new Error('repo not found');

    this.token = token;
    this.repo = repo;
    this._orgUrl = null;
    this._project = null;
    this._repositoryId = null;
  }

  async getOrgUrl() {
    if (this._orgUrl) return this._orgUrl;

    // Try to infer from environment variables
    if (SYSTEM_COLLECTIONURI) {
      this._orgUrl = SYSTEM_COLLECTIONURI.replace(/\/$/, '');
      return this._orgUrl;
    }

    // Try to infer from repo URL
    const url = new URL(this.repo);
    if (
      url.hostname === 'dev.azure.com' ||
      url.hostname.includes('visualstudio.com')
    ) {
      // Format: https://dev.azure.com/{organization}/{project}/_git/{repo}
      // or: https://{organization}.visualstudio.com/{project}/_git/{repo}
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (url.hostname === 'dev.azure.com' && pathParts.length >= 1) {
        this._orgUrl = `https://dev.azure.com/${pathParts[0]}`;
        if (pathParts.length >= 2) {
          this._project = pathParts[1];
        }
      } else if (url.hostname.includes('visualstudio.com')) {
        const org = url.hostname.replace('.visualstudio.com', '');
        this._orgUrl = `https://dev.azure.com/${org}`;
        if (pathParts.length >= 1) {
          this._project = pathParts[0];
        }
      } else {
        this._orgUrl = `https://dev.azure.com/${url.hostname.split('.')[0]}`;
      }
    } else {
      // TFS on-premises format: {server}/tfs/{collection}/{project}/_git/{repo}
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (pathParts[0] === 'tfs' && pathParts.length >= 2) {
        this._orgUrl = `${url.protocol}//${url.host}/${pathParts[0]}/${pathParts[1]}`;
        if (pathParts.length >= 3) {
          this.project = pathParts[2];
        }
      } else {
        throw new Error('Unable to determine Azure DevOps organization URL');
      }
    }

    return this._orgUrl;
  }

  async getProject() {
    if (this._project) return this._project;

    // Try environment variable first
    if (BUILD_REPOSITORY_URI) {
      const url = new URL(BUILD_REPOSITORY_URI);
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (url.hostname === 'dev.azure.com' && pathParts.length >= 2) {
        this._project = pathParts[1];
      } else if (
        url.hostname.includes('visualstudio.com') &&
        pathParts.length >= 1
      ) {
        this._project = pathParts[0];
      } else {
        const tfsMatch = url.pathname.match(/\/tfs\/[^/]+\/([^/]+)\//);
        if (tfsMatch) {
          this._project = tfsMatch[1];
        }
      }
    }

    // Fallback to parsing from repo URL
    if (!this._project) {
      await this.getOrgUrl(); // This may have set this._project via parsing
    }

    if (!this._project) {
      throw new Error('Unable to determine Azure DevOps project');
    }

    return this._project;
  }

  async getRepositoryId() {
    if (this._repositoryId) return this._repositoryId;

    // Try environment variable first
    if (BUILD_REPOSITORY_ID) {
      this._repositoryId = BUILD_REPOSITORY_ID;
      return this._repositoryId;
    }

    // Query API to get repository ID
    const project = await this.getProject();
    const repoUrl = new URL(this.repo);
    const repoName = repoUrl.pathname
      .split('/')
      .filter(Boolean)
      .pop()
      .replace('.git', '');

    // Try direct lookup first
    try {
      const endpoint = `/${project}/_apis/git/repositories/${encodeURIComponent(
        repoName
      )}?api-version=${API_VER}`;
      const response = await this.request({ endpoint, method: 'GET' });
      this._repositoryId = response.id;
      return this._repositoryId;
    } catch (err) {
      // Fallback: list repositories and find by name or remote URL
      logger.debug(
        `Direct repository lookup failed, trying list: ${err.message}`
      );
      const listEndpoint = `/${project}/_apis/git/repositories?api-version=${API_VER}`;
      const listResponse = await this.request({
        endpoint: listEndpoint,
        method: 'GET'
      });
      // Try to match by name
      const matchedRepo = listResponse.value?.find(
        (repo) =>
          repo.name === repoName ||
          repo.name.toLowerCase() === repoName.toLowerCase()
      );

      if (matchedRepo) {
        this._repositoryId = matchedRepo.id;
        return this._repositoryId;
      }

      // If still not found, try matching by remote URL
      const repoRemoteMatch = listResponse.value?.find((repo) => {
        const repoRemoteUrl = repo.remoteUrl || repo.webUrl;
        return (
          repoRemoteUrl && this.repo.includes(repoRemoteUrl.split('/').pop())
        );
      });

      if (repoRemoteMatch) {
        this._repositoryId = repoRemoteMatch.id;
        return this._repositoryId;
      }

      throw new Error(
        `Repository "${repoName}" not found in project "${project}"`
      );
    }
  }

  async commitCommentCreate(opts = {}) {
    // Azure DevOps doesn't have native commit comments
    // We'll create a comment on any PR associated with the commit
    const { commitSha, report } = opts;

    if (report.length >= MAX_COMMENT_SIZE) throw new Error(ERROR_COMMENT_SIZE);

    const prs = await this.commitPrs({ commitSha });
    if (prs.length === 0) {
      throw new Error(
        'Azure DevOps does not support commit comments directly. Please use PR comments instead.'
      );
    }

    // Use the first PR found
    const [firstPr] = prs;
    const prNumber = firstPr.url.split('/').slice(-1)[0];
    return await this.prCommentCreate({ report, prNumber });
  }

  async commitCommentUpdate(opts = {}) {
    throw new Error('Azure DevOps does not support commit comment updates!');
  }

  async commitComments(opts = {}) {
    // Azure DevOps doesn't have native commit comments
    // Return empty array as fallback
    return [];
  }

  async commitPrs(opts = {}) {
    const { commitSha } = opts;
    const project = await this.getProject();
    const repositoryId = await this.getRepositoryId();

    // Query PRs and filter by commit
    const endpoint = `/${project}/_apis/git/repositories/${repositoryId}/pullRequests?searchCriteria.status=active&api-version=${API_VER}`;
    const response = await this.request({ endpoint, method: 'GET' });

    const prsWithCommit = [];
    for (const pr of response.value || []) {
      // Get commits for this PR
      const commitsEndpoint = `/${project}/_apis/git/repositories/${repositoryId}/pullRequests/${pr.pullRequestId}/commits?api-version=${API_VER}`;
      try {
        const commitsResponse = await this.request({
          endpoint: commitsEndpoint,
          method: 'GET'
        });
        const hasCommit = commitsResponse.value?.some(
          (commit) => commit.commitId === commitSha
        );
        if (hasCommit) {
          prsWithCommit.push({
            url: pr.url
              .replace('_apis/git/pullRequests', '_git')
              .replace(/\?.*$/, ''),
            source: pr.sourceRefName?.replace('refs/heads/', ''),
            target: pr.targetRefName?.replace('refs/heads/', '')
          });
        }
      } catch (err) {
        logger.debug(
          `Failed to get commits for PR ${pr.pullRequestId}: ${err.message}`
        );
      }
    }

    return prsWithCommit;
  }

  async checkCreate() {
    throw new Error('Azure DevOps does not support checks!');
  }

  async upload(opts = {}) {
    const project = await this.getProject();
    const { size, mime, data } = await fetchUploadData(opts);
    logger.debug(`Project: ${project}`);
    logger.debug(
      `Uploading file to Azure DevOps, size: ${size}, mime: ${mime}`
    );
    logger.debug(`Data: ${data}`);

    // Use Azure DevOps Artifacts API to upload
    // This requires a build context, so we'll use a workaround with storage
    // For now, we'll use a generic upload approach similar to BitBucket
    const chunks = [];
    for await (const chunk of data) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    logger.debug(`Buffer: ${buffer}`);
    logger.debug(`Buffer length: ${buffer.length}`);
    logger.debug(`Buffer toString: ${buffer.toString()}`);
    logger.debug(`Buffer toJSON: ${buffer.toJSON()}`);

    // Use Universal Packages or Artifacts API
    // As a fallback, we can use external storage or return a data URI
    // For native Azure DevOps integration, this would ideally use Artifacts API
    // but that requires a build context which may not always be available

    // For now, throw an error suggesting alternative approaches
    throw new Error(
      'Azure DevOps native upload requires a build context. Consider using --publish (without --native) to use external storage, or ensure you are running within an Azure Pipelines build context.'
    );
  }

  async runnerToken() {
    throw new Error(
      'Azure DevOps does not support runner token retrieval via API!'
    );
  }

  async registerRunner(opts = {}) {
    throw new Error('Azure DevOps does not support registerRunner via API!');
  }

  async unregisterRunner(opts = {}) {
    throw new Error('Azure DevOps does not support unregisterRunner via API!');
  }

  async startRunner(opts) {
    throw new Error(
      'Azure DevOps self-hosted runners must be configured manually!'
    );
  }

  async runners(opts = {}) {
    throw new Error('Azure DevOps does not support listing runners via API!');
  }

  async runnerById(opts = {}) {
    throw new Error('Azure DevOps does not support runnerById via API!');
  }

  runnerLogPatterns() {
    return {
      ready: /Agent ready/,
      job_started: /Starting job/,
      job_ended: /Finishing job/,
      job_ended_succeded: /Finishing job.*succeeded/
    };
  }

  async prCreate(opts = {}) {
    const project = await this.getProject();
    const repositoryId = await this.getRepositoryId();
    const { source, target, title, description, skipCi, autoMerge } = opts;

    const prTitle = skipCi ? title + ' [skip ci]' : title;
    const endpoint = `/${project}/_apis/git/repositories/${repositoryId}/pullRequests?api-version=${API_VER}`;
    const body = JSON.stringify({
      sourceRefName: `refs/heads/${source}`,
      targetRefName: `refs/heads/${target}`,
      title: prTitle,
      description: description
    });

    const response = await this.request({ endpoint, method: 'POST', body });

    if (autoMerge) {
      await this.prAutoMerge({
        pullRequestId: response.pullRequestId,
        mergeMode: autoMerge
      });
    }

    return response.url
      .replace('_apis/git/pullRequests', '_git')
      .replace(/\?.*$/, '');
  }

  async prAutoMerge({ pullRequestId, mergeMode, mergeMessage }) {
    const project = await this.getProject();
    const repositoryId = await this.getRepositoryId();

    if (mergeMode === 'rebase') {
      throw new Error(
        `Rebase auto-merge mode not implemented for Azure DevOps`
      );
    }

    const endpoint = `/${project}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}?api-version=${API_VER}`;
    const updateBody = {
      autoCompleteSetBy: {
        id: 'current-user' // This would need actual user ID in real implementation
      },
      completionOptions: {
        mergeCommitMessage:
          mergeMessage || `Auto-merged via CML (${mergeMode})`,
        squashMerge: mergeMode === 'squash',
        deleteSourceBranch: true
      }
    };

    try {
      await this.request({
        endpoint,
        method: 'PATCH',
        body: JSON.stringify(updateBody)
      });
    } catch ({ message }) {
      logger.warn(
        `Failed to enable auto-merge: ${message}. Trying to merge immediately...`
      );
      // Fallback to immediate merge
      const mergeEndpoint = `/${project}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}?api-version=${API_VER}`;
      await this.request({
        endpoint: mergeEndpoint,
        method: 'PATCH',
        body: JSON.stringify({
          status: 'completed',
          completionOptions: {
            mergeCommitMessage: mergeMessage || `Merged via CML (${mergeMode})`,
            squashMerge: mergeMode === 'squash',
            deleteSourceBranch: true
          }
        })
      });
    }
  }

  async issueCommentUpsert(opts = {}) {
    // Azure DevOps uses Work Items, but for simplicity we'll throw an error
    // and suggest using PR comments instead
    throw new Error(
      'Azure DevOps issue comments are not directly supported. Use PR comments instead, or implement Work Items API integration.'
    );
  }

  async issueCommentCreate(opts = {}) {
    const { id, ...rest } = opts;
    return this.issueCommentUpsert(rest);
  }

  async issueCommentUpdate(opts = {}) {
    if (!opts.id) throw new Error('Id is missing updating comment');
    return this.issueCommentUpsert(opts);
  }

  async issueComments(opts = {}) {
    throw new Error(
      'Azure DevOps issue comments are not directly supported. Use PR comments instead.'
    );
  }

  async prCommentCreate(opts = {}) {
    const project = await this.getProject();
    const repositoryId = await this.getRepositoryId();
    const { report, prNumber } = opts;

    if (report.length >= MAX_COMMENT_SIZE) throw new Error(ERROR_COMMENT_SIZE);

    // Azure DevOps PR comments are added as threads
    // First, check if there's an existing thread we should update
    const threadsEndpoint = `/${project}/_apis/git/repositories/${repositoryId}/pullRequests/${prNumber}/threads?api-version=${API_VER}`;
    const threads = await this.request({
      endpoint: threadsEndpoint,
      method: 'GET'
    });
    logger.debug(`Threads: ${threads}`);

    // Create a new thread for the comment
    const endpoint = `/${project}/_apis/git/repositories/${repositoryId}/pullRequests/${prNumber}/threads?api-version=${API_VER}`;
    const body = JSON.stringify({
      comments: [
        {
          parentCommentId: 0,
          content: report,
          commentType: 1 // Text comment
        }
      ],
      status: 1 // Active
    });

    const response = await this.request({ endpoint, method: 'POST', body });
    logger.debug(`Response: ${response}`);

    // Return URL to the PR thread
    const prUrl = this.repo.replace('_git', '_pullrequest');
    return `${prUrl}?_a=overview&pullRequestId=${prNumber}`;
  }

  async prCommentUpdate(opts = {}) {
    const project = await this.getProject();
    const repositoryId = await this.getRepositoryId();
    const { report, prNumber, id: threadId } = opts;

    if (report.length >= MAX_COMMENT_SIZE) throw new Error(ERROR_COMMENT_SIZE);

    // Get the thread to find the comment ID
    const threadEndpoint = `/${project}/_apis/git/repositories/${repositoryId}/pullRequests/${prNumber}/threads/${threadId}?api-version=${API_VER}`;
    const thread = await this.request({
      endpoint: threadEndpoint,
      method: 'GET'
    });

    if (!thread.comments || thread.comments.length === 0) {
      throw new Error('Thread has no comments to update');
    }

    // Update the first comment in the thread
    const commentId = thread.comments[0].id;
    const commentEndpoint = `/${project}/_apis/git/repositories/${repositoryId}/pullRequests/${prNumber}/threads/${threadId}/comments/${commentId}?api-version=${API_VER}`;
    const body = JSON.stringify({
      content: report
    });

    await this.request({ endpoint: commentEndpoint, method: 'PATCH', body });

    const prUrl = this.repo.replace('_git', '_pullrequest');
    return `${prUrl}?_a=overview&pullRequestId=${prNumber}`;
  }

  async prComments(opts = {}) {
    const project = await this.getProject();
    const repositoryId = await this.getRepositoryId();
    const { prNumber } = opts;

    const endpoint = `/${project}/_apis/git/repositories/${repositoryId}/pullRequests/${prNumber}/threads?api-version=${API_VER}`;
    const response = await this.request({ endpoint, method: 'GET' });

    // Flatten threads into comments
    const comments = [];
    for (const thread of response.value || []) {
      for (const comment of thread.comments || []) {
        comments.push({
          id: thread.id, // Use thread ID as comment ID for update purposes
          body: comment.content
        });
      }
    }

    return comments;
  }

  async prs(opts = {}) {
    const project = await this.getProject();
    const repositoryId = await this.getRepositoryId();
    const { state = 'active' } = opts;

    const statusMap = {
      active: 'active',
      open: 'active',
      closed: 'completed',
      merged: 'completed'
    };

    const status = statusMap[state.toLowerCase()] || 'active';
    const endpoint = `/${project}/_apis/git/repositories/${repositoryId}/pullRequests?searchCriteria.status=${status}&api-version=${API_VER}`;
    const response = await this.request({ endpoint, method: 'GET' });

    return (response.value || []).map((pr) => {
      return {
        url: pr.url
          .replace('_apis/git/pullRequests', '_git')
          .replace(/\?.*$/, ''),
        source: pr.sourceRefName?.replace('refs/heads/', ''),
        target: pr.targetRefName?.replace('refs/heads/', '')
      };
    });
  }

  async pipelineRerun({ id = BUILD_BUILDID, jobId } = {}) {
    const project = await this.getProject();

    if (!id && jobId) {
      logger.warn('Azure DevOps does not support pipelineRerun by jobId!');
      return;
    }

    // Azure DevOps uses "rerun" API
    const endpoint = `/${project}/_apis/build/builds/${id}?api-version=${API_VER}`;
    const { status } = await this.request({ endpoint, method: 'GET' });

    if (status === 'inProgress') {
      const cancelEndpoint = `/${project}/_apis/build/builds/${id}?api-version=${API_VER}`;
      await this.request({
        endpoint: cancelEndpoint,
        method: 'PATCH',
        body: JSON.stringify({ status: 'cancelling' })
      });
    }

    const rerunEndpoint = `/${project}/_apis/build/builds?api-version=${API_VER}`;
    const build = await this.request({
      endpoint: `${endpoint}`,
      method: 'GET'
    });
    await this.request({
      endpoint: rerunEndpoint,
      method: 'POST',
      body: JSON.stringify({
        definition: { id: build.definition.id },
        sourceBranch: build.sourceBranch,
        sourceVersion: build.sourceVersion
      })
    });
  }

  async pipelineJobs(opts = {}) {
    logger.warn('Azure DevOps pipelineJobs requires build context');
    return [];
  }

  async updateGitConfig({ userName, userEmail, remote } = {}) {
    const repo = new URL(this.repo);
    repo.password = this.token;
    repo.username = 'PAT'; // Personal Access Token

    const commands = [
      ['git', 'config', 'user.name', userName || this.userName],
      ['git', 'config', 'user.email', userEmail || this.userEmail],
      [
        'git',
        'remote',
        'set-url',
        remote,
        repo.toString() + (repo.toString().endsWith('.git') ? '' : '.git')
      ]
    ];

    return commands;
  }

  get workflowId() {
    return SYSTEM_DEFINITIONID || BUILD_BUILDID;
  }

  get runId() {
    return BUILD_BUILDID;
  }

  get sha() {
    return BUILD_SOURCEVERSION;
  }

  /**
   * Returns the PR number if we're in a PR-related action event.
   */
  get pr() {
    if (SYSTEM_PULLREQUEST_PULLREQUESTID) {
      return SYSTEM_PULLREQUEST_PULLREQUESTID;
    }
    return null;
  }

  get branch() {
    if (BUILD_SOURCEBRANCH) {
      return BUILD_SOURCEBRANCH.replace('refs/heads/', '').replace('refs/', '');
    }
    return null;
  }

  get userEmail() {
    return process.env.BUILD_REQUESTEDFOREMAIL || 'cml@azure.devops';
  }

  get userName() {
    return process.env.BUILD_REQUESTEDFOR || 'Azure DevOps';
  }

  async request(opts = {}) {
    const { token } = this;
    const { endpoint, method = 'GET', body, raw } = opts;
    let { url } = opts;

    if (endpoint) {
      const orgUrl = await this.getOrgUrl();
      url = `${orgUrl}/_apis${endpoint}`;
    }
    if (!url) throw new Error('Azure DevOps API endpoint not found');

    logger.debug(`Azure DevOps API request, method: ${method}, url: "${url}"`);

    // Azure DevOps uses Basic auth with PAT (base64 encoded :PAT)
    const auth = Buffer.from(`:${token}`).toString('base64');
    const headers = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    };

    const response = await fetch(url, {
      method,
      headers,
      body,
      agent: new ProxyAgent()
    });

    if (!response.ok) {
      logger.debug(`Response status is ${response.status}`);
      let errorMessage = response.statusText;
      try {
        const errorBody = await response.json();
        if (errorBody.message) {
          errorMessage = errorBody.message;
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
      throw new Error(errorMessage);
    }

    if (raw) return response;

    return await response.json();
  }

  warn(message) {
    logger.warn(message);
  }
}

module.exports = AzureDevOps;
