import type { reportKindEnum } from "../db/schema.ts";
import type { dailyReports, reportItems, reportRevisions } from "../db/schema.ts";

export type DailyReport = typeof dailyReports.$inferSelect;
export type ReportRevision = typeof reportRevisions.$inferSelect;
export type ReportItem = typeof reportItems.$inferSelect;
export type ReportItemStatus = ReportItem["status"];
export type ObstacleCategory = NonNullable<ReportItem["obstacleCategory"]>;

export interface AddReportItemInput {
  activity: string;
  result?: string;
  obstacle?: string;
  obstacleCategory?: ObstacleCategory;
  status?: ReportItemStatus;
  taskId?: string;
  /** Set at ingest when the text names exactly one project — see projects/matching.ts. */
  projectId?: string;
}

export interface ReportSummary {
  activityCount: number;
  taskUpdateCount: number;
  taskDoneCount: number;
}

export type ReportKind = (typeof reportKindEnum.enumValues)[number];
