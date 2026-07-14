import { cvDataSchema } from '../lambda/cv-schema';

const baseCv = {
  personalInfo: {
    fullName: 'Hiro Nakamata',
    title: 'Engineer',
    email: 'admin@example.com',
    phone: '',
    links: { website: '', github: '', linkedin: '' },
  },
  summary: '',
  technicalSkills: [],
  experience: [],
  qualifications: [],
  education: [],
};

test('accepts empty strings for untouched link fields', () => {
  expect(cvDataSchema.safeParse(baseCv).success).toBe(true);
});

test('accepts valid URLs in link fields', () => {
  const cv = {
    ...baseCv,
    personalInfo: {
      ...baseCv.personalInfo,
      links: { website: 'https://nakamata.tech', github: '', linkedin: '' },
    },
  };
  expect(cvDataSchema.safeParse(cv).success).toBe(true);
});

test('still rejects malformed URLs in link fields', () => {
  const cv = {
    ...baseCv,
    personalInfo: {
      ...baseCv.personalInfo,
      links: { website: 'not-a-url', github: '', linkedin: '' },
    },
  };
  expect(cvDataSchema.safeParse(cv).success).toBe(false);
});

test('accepts reference-format sections', () => {
  const cv = {
    ...baseCv,
    technicalSkills: [{ category: 'Languages', skills: ['TypeScript', 'Kotlin'] }],
    experience: [
      {
        company: 'Example Corp',
        role: 'Senior Engineer',
        startDate: 'January 2022',
        endDate: 'Present',
        bullets: ['Did things'],
        techstack: 'TypeScript, AWS',
      },
    ],
    qualifications: [{ label: 'Java', text: '11 years of backend development' }],
    education: [
      { institution: 'Example University', degree: 'B.S.', startDate: '2014', endDate: '2018' },
    ],
  };
  expect(cvDataSchema.safeParse(cv).success).toBe(true);
});

test('rejects skill categories without a label', () => {
  const cv = {
    ...baseCv,
    technicalSkills: [{ category: '', skills: ['TypeScript'] }],
  };
  expect(cvDataSchema.safeParse(cv).success).toBe(false);
});
