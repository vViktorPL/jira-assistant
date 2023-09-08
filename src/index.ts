import { Version3Client, Version3Models } from 'jira.js'
import { default as PromiseThrottle } from 'promise-throttle'
import { generatePdf } from 'html-pdf-node';
import { escape } from 'html-escaper'
import * as fs from 'fs';
import * as dotenv from 'dotenv'
dotenv.config()

const email = process.env.JIRA_USER_EMAIL;
const jiraPersonalAccessToken = process.env.JIRA_PERSONAL_ACCESS_TOKEN;
const jiraHost = process.env.JIRA_HOST_URL;
const title = process.env.DOCUMENT_TITLE;

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

async function getMyWorklogsForPeriod(fromDate: Date, toDate: Date, mode: WorklogMode): Promise<(string | number)[][]> {
  const worklogDateRange = [fromDate, toDate].map(date => date.toJSON().split('T')[0]);

  const issuesSearchResponse = await jiraClient.issueSearch.searchForIssuesUsingJql({
    jql: `worklogDate >= \'${worklogDateRange[0]}\' AND worklogDate <= \'${worklogDateRange[1]}\' AND worklogAuthor = currentUser()`,
    fields: ['id'],
    maxResults: 100,
  });

  if (!issuesSearchResponse.issues) {
    return [];
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
          startedAfter: +fromDate,
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
        comment: (worklog.comment && extractTextFromJiraDocumentNode(worklog.comment)) ?? '',
      }))
  ).sort((worklogA, worklogB) => +new Date(worklogA.started) - +new Date(worklogB.started))

  const hoursSum = worklogs.reduce((sum, worklog) => sum + worklog.timeSpentInHours, 0).toString().replace('.', ',');

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

      return [['Date', 'Issue', 'Hours spent', 'Comment'], ...csvEntries, ['Total', '', hoursSum, '']];
      // console.log('Date,Issue,Hours spent,Comment');
      // console.log(stringify(csvEntries));
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

      return [['Date', 'Hours spent', 'Issues'], ...csvEntries, ['Total', hoursSum, '']];
      // console.log("Date,Hours,Issues");
      // console.log(stringify(csvEntries));
      // break;
    }
  }
}

const firstDayOfCurrentMonth = new Date();
firstDayOfCurrentMonth.setDate(1);
firstDayOfCurrentMonth.setHours(0, 0, 0, 0);

const firstDayOfPreviousMonth = new Date(firstDayOfCurrentMonth);
firstDayOfPreviousMonth.setMonth(firstDayOfCurrentMonth.getMonth() - 1);

const getLastDayOfMonth = (date: Date) => {
  const result = new Date(date);
  result.setMonth(result.getMonth() + 1);
  result.setDate(0);

  return result;
}

(async () => {
  const currentDate = new Date();
  const reportDateStart = currentDate.getDate() > 15 ? firstDayOfCurrentMonth : firstDayOfPreviousMonth;
  const reportDateEnd = getLastDayOfMonth(reportDateStart);
  const entries = await getMyWorklogsForPeriod(reportDateStart, reportDateEnd, WorklogMode.DailySummary);

  const content = `
    <style>
      html { -webkit-print-color-adjust: exact; }
      
      body {
        margin: 1.5em 2.5em;
      }
    
      table {
        width: 100%;
        border-collapse: collapse;
      }
      
      table, td, th {
        border: solid 1px;
      }

      tr:last-child {
        background: lightgray;
        font-weight: bold;
      }
      
      tr:last-child td {
        border-top-width: 2px;
      }
    </style>

    <h1>${title ? `${escape(title)} - ` : ''}${reportDateStart.toLocaleDateString('pl', {
    year: "numeric",
    month: "long",
  })}</h1><table>${entries.map(
    (entry, rowIndex) => (`<tr>${
      entry.map(cell => rowIndex === 0 ? `<th>${escape(String(cell))}</th>` : `<td>${escape(String(cell))}</td>`).join('')
    }</tr>`)
  ).join('\n')}</table>`;


  generatePdf({
    content
  }, {}, (err, buffer) => {
    if (err) {
      console.error(err);
      return;
    }

    fs.writeFile('worklog.pdf', buffer, err => {
      if (err) {
        console.error(err);
      }
    })
  });
})();

const extractTextFromJiraDocumentNode = (documentNode: Version3Models.Document | Omit<Version3Models.Document, 'version'>): string => {
  const contentsText = (documentNode.content ?? [])
    .map(extractTextFromJiraDocumentNode)
    .reduce((accumulatedText, text) => accumulatedText.concat(text), '');
  const innerText = documentNode.text ?? '';

  return contentsText + innerText;
}
