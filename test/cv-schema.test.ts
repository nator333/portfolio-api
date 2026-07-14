import { cvDataSchema } from '../lambda/cv-schema';

const baseCv = {
  personalInfo: {
    fullName: 'Hiro Nakamata',
    title: 'Engineer',
    email: 'admin@example.com',
    phone: '',
    location: '',
    links: { website: '', github: '', linkedin: '' },
  },
  summary: '',
  experience: [],
  education: [],
  skills: [],
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
