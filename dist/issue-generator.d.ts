import type { StepEntry } from './step-log.js';
import type { Findings, FindingsMode } from './report-generator.js';
export interface IssueContent {
    /** Suggested issue title */
    title: string;
    /** Markdown body ready for Linear */
    body: string;
    /** Key screenshots to attach (absolute paths + captions) */
    screenshots: Array<{
        path: string;
        caption: string;
        step: number;
    }>;
}
export declare function generateIssueContent(options: {
    steps: StepEntry[];
    findings: Findings;
    scenarioName?: string;
    mode?: FindingsMode;
    screenshotDir: string;
}): IssueContent;
