import { z } from 'zod';

export const CV_TABLE_ITEM_ID = 'current';

// Untouched form inputs arrive as "" rather than being omitted, so each link
// accepts a valid URL, an empty string, or absence.
const optionalUrl = z.string().url().or(z.literal('')).optional();

const linksSchema = z.object({
  website: optionalUrl,
  github: optionalUrl,
  linkedin: optionalUrl,
});

const personalInfoSchema = z.object({
  fullName: z.string().min(1),
  title: z.string(),
  email: z.string().email(),
  phone: z.string(),
  location: z.string(),
  links: linksSchema,
});

const experienceEntrySchema = z.object({
  company: z.string().min(1),
  role: z.string().min(1),
  startDate: z.string(),
  endDate: z.string(),
  location: z.string(),
  bullets: z.array(z.string()),
});

const educationEntrySchema = z.object({
  institution: z.string().min(1),
  degree: z.string().min(1),
  startDate: z.string(),
  endDate: z.string(),
});

export const cvDataSchema = z.object({
  personalInfo: personalInfoSchema,
  summary: z.string(),
  experience: z.array(experienceEntrySchema),
  education: z.array(educationEntrySchema),
  skills: z.array(z.string()),
});

export type CvData = z.infer<typeof cvDataSchema>;
