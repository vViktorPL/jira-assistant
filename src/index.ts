import { Version3Client, Version3Models } from 'jira.js'
import { default as PromiseThrottle } from 'promise-throttle'
import { stringify } from 'csv-stringify/sync'
import * as dotenv from 'dotenv'
dotenv.config()

const email = process.env.JIRA_USER_EMAIL;
const jiraPersonalAccessToken = process.env.JIRA_PERSONAL_ACCESS_TOKEN;
const jiraHost = process.env.JIRA_HOST_URL;

if (!email) {
  throw new Error('No JIRA user email provided');
}
if (!jiraPersonalAccessToken) {
  throw new Error('No JIRA personal access token provided');
}
if (!jiraHost) {
  throw new Error('Missing JIRA host URL');
}

const jiraClient = new Version3Client({
  host: jiraHost,
  authentication: {
    basic: {
      username: email,
      password: jiraPersonalAccessToken
    },
  },
});

enum WorklogMode {
  Detailed,
  DailySummary,
}

async function getMyWorklogsSince(date: Date, mode: WorklogMode) {
  const worklogDate = date.toJSON().split('T')[0];

  const issuesSearchResponse = await jiraClient.issueSearch.searchForIssuesUsingJql({
    jql: `worklogDate >= \'${worklogDate}\' AND worklogAuthor = currentUser()`,
    fields: ['id'],
    maxResults: 100,
  });

  if (!issuesSearchResponse.issues) {
    return;
  }

  const issueByIdMap = new Map<string, Version3Models.Issue>();
  issuesSearchResponse.issues.forEach(
    issue => issueByIdMap.set(issue.id, issue)
  );

  const promiseThrottle = new PromiseThrottle({
    requestsPerSecond: 3,
  });

  const worklogsPerIssue = await Promise.all(
    issuesSearchResponse.issues.map(
      ({ key }) =>
        promiseThrottle.add(() =>
          jiraClient.issueWorklogs.getIssueWorklog({
          issueIdOrKey: key,
          startedAfter: +date,
        }))
    )
  );

  const worklogs = worklogsPerIssue.flatMap(
    worklogResponse => worklogResponse.worklogs
      .filter((worklog) => worklog.author?.emailAddress === email)
      .map((worklog) => ({
        started: worklog.started!,
        issue: issueByIdMap.get(worklog.issueId!)!.key,
        timeSpentInHours: (worklog.timeSpentSeconds ?? 0) / 3600,
        comment: worklog.comment && extractTextFromJiraDocumentNode(worklog.comment),
      }))
  ).sort((worklogA, worklogB) => +new Date(worklogA.started) - +new Date(worklogB.started))

  switch (mode) {
    case WorklogMode.Detailed: {
      const csvEntries = worklogs.map(
        worklog => [
          worklog.started.split('T')[0],
          worklog.issue,
          worklog.timeSpentInHours.toString().replace('.', ','),
          worklog.comment,
        ]
      );

      console.log('Date,Issue,Hours spent,Comment');
      console.log(stringify(csvEntries));
      break;
    }

    case WorklogMode.DailySummary: {
      const csvEntries = Array.from(
        worklogs.reduce(
          (dailyWorklogs, worklog) => {
            const day = worklog.started.split('T')[0];
            if (!dailyWorklogs.has(day)) {
              dailyWorklogs.set(day, {timeSpentInHours: 0, issues: []});
            }

            const dailyWorklog = dailyWorklogs.get(day)!;

            dailyWorklog.timeSpentInHours += worklog.timeSpentInHours;
            if (!dailyWorklog.issues.includes(worklog.issue)) {
              dailyWorklog.issues.push(worklog.issue);
            }

            return dailyWorklogs;
          },
          new Map<string, { timeSpentInHours: number, issues: string[] }>
        ).entries()
      ).map(
        ([day, dailySummary]) => [
          day, dailySummary.timeSpentInHours, dailySummary.issues.join(', ')
        ]
      );
      console.log("Date,Hours,Issues");
      console.log(stringify(csvEntries));
      break;
    }
  }
}

getMyWorklogsSince(new Date('2023-02-01'), WorklogMode.Detailed);


const extractTextFromJiraDocumentNode = (documentNode: Version3Models.Document | Omit<Version3Models.Document, 'version'>): string => {
  const contentsText = (documentNode.content ?? [])
    .map(extractTextFromJiraDocumentNode)
    .reduce((accumulatedText, text) => accumulatedText.concat(text), '');
  const innerText = documentNode.text ?? '';

  return contentsText + innerText;
}
