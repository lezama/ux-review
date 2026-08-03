interface ReportOptions {
    actionLogPath: string;
    screenshotDir: string;
    outputPath?: string;
}
export declare function generateReport(options: ReportOptions): string;
export interface Findings {
    scenario: string;
    personas: string[];
    workedWell: string[];
    frictionPoints: string[];
    suggestions: string[];
    markdown: string;
}
export type FindingsMode = 'simulator' | 'expert';
/**
 * Generate UX findings from narration text and scene flow.
 *
 * Classifies observations into positive/negative signals.
 */
export declare function generateFindings(options: {
    actionLogPath: string;
    scenarioName?: string;
}): Findings;
/**
 * Generate expert UX findings classified by review lens.
 *
 * Modeled after the review style of Matías Ventura and Pablo Honey.
 */
export declare function generateExpertFindings(options: {
    actionLogPath: string;
    scenarioName?: string;
}): Findings;
export {};
