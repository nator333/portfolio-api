import { z } from 'zod';

// Stored in the same single-document table as the CV, under a distinct id.
export const PROJECTS_TABLE_ITEM_ID = 'projects';

// Untouched form inputs arrive as "" rather than being omitted, so URL links
// accept a valid URL, an empty string, or absence.
const optionalUrl = z.string().url().or(z.literal('')).optional();

const projectEntrySchema = z.object({
  title: z.string().min(1),
  tech: z.string(),
  description: z.string(),
  image: z.string(),
  tags: z.array(z.string()),
  liveUrl: optionalUrl,
  githubUrl: optionalUrl,
});

export const projectsDataSchema = z.object({
  projects: z.array(projectEntrySchema),
});

export type ProjectsData = z.infer<typeof projectsDataSchema>;
