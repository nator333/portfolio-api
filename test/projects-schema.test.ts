import { projectsDataSchema } from '../lambda/projects-schema';

const baseProject = {
  title: 'Portfolio Site',
  tech: 'Angular, AWS',
  description: 'A personal portfolio.',
  image: 'assets/projects/portfolio.png',
  tags: ['Angular', 'AWS'],
  liveUrl: 'https://nakamata.tech',
  githubUrl: '',
};

test('accepts a valid projects document', () => {
  expect(projectsDataSchema.safeParse({ projects: [baseProject] }).success).toBe(true);
});

test('accepts an empty projects list', () => {
  expect(projectsDataSchema.safeParse({ projects: [] }).success).toBe(true);
});

test('accepts empty strings for optional url fields', () => {
  const project = { ...baseProject, liveUrl: '', githubUrl: '' };
  expect(projectsDataSchema.safeParse({ projects: [project] }).success).toBe(true);
});

test('rejects malformed urls', () => {
  const project = { ...baseProject, liveUrl: 'not-a-url' };
  expect(projectsDataSchema.safeParse({ projects: [project] }).success).toBe(false);
});

test('rejects a project without a title', () => {
  const project = { ...baseProject, title: '' };
  expect(projectsDataSchema.safeParse({ projects: [project] }).success).toBe(false);
});
