import * as core from '@actions/core';
import * as github from '@actions/github';
import { AnnotationFilterLevel, CheckConclusion } from '../helpers/types.js';
import { updateCheckRun } from '../src/checks.js';
import { fileLoader } from '../src/files.js';
import { getAssociatedPullRequest } from '../src/git.js';
import { run } from '../src/run.js';

vi.mock('../src/checks');
vi.mock('../src/git');
vi.mock('../src/files');

const mockUpdateCheckRun = updateCheckRun as vi.MockedFunction<typeof updateCheckRun>;
const mockFileLoader = fileLoader as vi.MockedFunction<typeof fileLoader>;
const mockGetAssociatedPullRequest = getAssociatedPullRequest as vi.MockedFunction<
  typeof getAssociatedPullRequest
>;

describe('Inspector Action', () => {
  const mockLoadFile = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadFile.mockReset();
    mockUpdateCheckRun.mockClear();

    // Mock error/warning/info/debug
    vi.spyOn(core, 'error').mockImplementation(vi.fn());
    vi.spyOn(core, 'warning').mockImplementation(vi.fn());
    vi.spyOn(core, 'info').mockImplementation(vi.fn());
    vi.spyOn(core, 'debug').mockImplementation(vi.fn());

    vi.spyOn(core, 'getInput').mockImplementation((name: string, _options) => {
      switch (name) {
        case 'github-token':
          return 'MOCK_GITHUB_TOKEN';
        case 'schema':
          return 'master:schema.graphql';
        default:
          return '';
      }
    });

    vi.spyOn(github, 'getOctokit').mockReturnValue({
      rest: {
        checks: {
          create: vi.fn().mockResolvedValue({
            data: {
              id: '2',
            },
          }),
        },
      },
    });
    vi.spyOn(github.context, 'repo', 'get').mockImplementation(() => {
      return {
        owner: 'some-owner',
        repo: 'graphql-inspector',
      };
    });

    mockGetAssociatedPullRequest.mockResolvedValue({
      state: 'open',
      number: 1,
      base: {
        ref: 'master',
      },
    });
    mockFileLoader.mockReturnValue(mockLoadFile);

    process.env.GITHUB_WORKSPACE = '/workspace';
  });

  describe('annotation-level', () => {
    function setInputs(inputs: Record<string, string>) {
      vi.spyOn(core, 'getInput').mockImplementation(name => {
        const values: Record<string, string> = {
          'github-token': 'MOCK_GITHUB_TOKEN',
          schema: 'master:schema.graphql',
          ...inputs,
        };
        return values[name] || '';
      });
    }

    beforeEach(() => {
      vi.spyOn(core, 'setOutput').mockImplementation(vi.fn());
      vi.spyOn(core, 'setFailed').mockImplementation(vi.fn());
      mockLoadFile
        .mockResolvedValueOnce(/* GraphQL */ `
          type Query {
            value: String
            choice: Choice
          }
          enum Choice {
            A
          }
        `)
        .mockResolvedValueOnce(/* GraphQL */ `
          type Query {
            value: Int
            choice: Choice
            added: String
          }
          enum Choice {
            A
            B
          }
        `);
    });

    it.each([
      { level: '', levels: ['failure', 'notice', 'warning'] },
      { level: AnnotationFilterLevel.All, levels: ['failure', 'notice', 'warning'] },
      { level: AnnotationFilterLevel.Dangerous, levels: ['failure', 'warning'] },
      { level: AnnotationFilterLevel.Breaking, levels: ['failure'] },
    ])('filters at "$level" without changing the summary or failure', async ({ level, levels }) => {
      setInputs({ 'annotation-level': level });

      await run();

      const result = mockUpdateCheckRun.mock.calls[0][2];
      expect(result.conclusion).toBe(CheckConclusion.Failure);
      expect(result.output.annotations?.map(a => a.annotation_level).sort()).toEqual(levels);
      expect(result.output.summary).toContain('Found 3 changes');
      expect(result.output.summary).toContain('Breaking: 1');
      expect(result.output.summary).toContain('Dangerous: 1');
      expect(result.output.summary).toContain('Safe: 1');
      expect(core.setOutput).toHaveBeenCalledWith('changes', '3');
    });

    it('disables all annotations when annotations is false', async () => {
      setInputs({ 'annotation-level': AnnotationFilterLevel.Breaking, annotations: 'false' });

      await run();

      const result = mockUpdateCheckRun.mock.calls[0][2];
      expect(result.output.annotations).toEqual([]);
      expect(result.conclusion).toBe(CheckConclusion.Failure);
      expect(result.output.summary).toContain('Found 3 changes');
    });

    it.each(['approve-label', 'fail-on-breaking'])('preserves the %s override', async override => {
      setInputs({
        'annotation-level': AnnotationFilterLevel.Breaking,
        [override]: override === 'approve-label' ? 'expected-breaking-change' : 'false',
      });
      if (override === 'approve-label') {
        mockGetAssociatedPullRequest.mockResolvedValue({
          state: 'open',
          number: 1,
          labels: [{ name: 'expected-breaking-change' }],
          base: { ref: 'master' },
        });
      }

      await run();

      const result = mockUpdateCheckRun.mock.calls[0][2];
      expect(result.conclusion).toBe(CheckConclusion.Success);
      expect(result.output.annotations?.map(a => a.annotation_level)).toEqual(['failure']);
      expect(result.output.summary).toContain('Breaking: 1');
    });

    it('filters using the severity after applying rules', async () => {
      setInputs({
        'annotation-level': AnnotationFilterLevel.Breaking,
        rules: 'example/rules/custom-rule.js',
      });

      await run();

      const result = mockUpdateCheckRun.mock.calls[0][2];
      expect(result.output.annotations).toEqual([]);
      expect(result.conclusion).toBe(CheckConclusion.Success);
      expect(result.output.summary).toContain('Found 3 changes');
      expect(core.setOutput).toHaveBeenCalledWith('changes', '3');
    });

    it('rejects invalid levels before creating a check', async () => {
      setInputs({ 'annotation-level': 'error' });

      await run();

      expect(core.setFailed).toHaveBeenCalledWith(
        'Invalid annotation-level. Expected one of: all, dangerous, breaking.',
      );
      expect(github.getOctokit).not.toHaveBeenCalled();
      expect(mockUpdateCheckRun).not.toHaveBeenCalled();
    });
  });

  describe('rules', () => {
    it('should accept a rules list with 1 built in rule', async () => {
      vi.spyOn(core, 'getInput').mockImplementation((name: string, _options) => {
        switch (name) {
          case 'github-token':
            return 'MOCK_GITHUB_TOKEN';
          case 'schema':
            return 'master:schema.graphql';
          case 'rules':
            return `
        suppressRemovalOfDeprecatedField
        `;
          default:
            return '';
        }
      });

      mockLoadFile
        .mockResolvedValueOnce(/* GraphQL */ `
          type Query {
            oldQuery: OldType @deprecated(reason: "use newQuery")
            newQuery: Int!
          }

          type OldType {
            field: String!
          }
        `)
        .mockResolvedValueOnce(/* GraphQL */ `
          type Query {
            newQuery: Int!
          }
        `);

      await run();

      expect(mockUpdateCheckRun).toBeCalledWith(expect.anything(), '2', {
        conclusion: CheckConclusion.Success,
        output: {
          title: 'Everything looks good',
          summary: expect.stringContaining('Found 2 changes'),
          annotations: [
            {
              annotation_level: 'warning',
              end_line: 1,
              message: "Type 'OldType' was removed",
              path: 'schema.graphql',
              start_line: 1,
              title: "Type 'OldType' was removed",
            },
            {
              annotation_level: 'warning',
              end_line: 2,
              message: expect.any(String),
              path: 'schema.graphql',
              start_line: 2,
              title: "Field 'oldQuery' (deprecated) was removed from object type 'Query'",
            },
          ],
        },
      });
    });

    it('should accept a rules list with 1 custom rule', async () => {
      vi.spyOn(core, 'getInput').mockImplementation((name: string, _options) => {
        switch (name) {
          case 'github-token':
            return 'MOCK_GITHUB_TOKEN';
          case 'schema':
            return 'master:schema.graphql';
          case 'rules':
            // This rule turns all changes from breaking to dangerous
            return `
        example/rules/custom-rule.js
        `;
          default:
            return '';
        }
      });

      mockLoadFile
        .mockResolvedValueOnce(/* GraphQL */ `
          type Query {
            oldQuery: OldType @deprecated(reason: "use newQuery")
            newQuery: Int!
          }

          type OldType {
            field: String!
          }
        `)
        .mockResolvedValueOnce(/* GraphQL */ `
          type Query {
            newQuery: Int!
          }
        `);

      await run();

      expect(mockUpdateCheckRun).toBeCalledWith(expect.anything(), '2', {
        conclusion: CheckConclusion.Success,
        output: {
          title: 'Everything looks good',
          summary: expect.stringContaining('Found 2 changes'),
          annotations: [
            {
              annotation_level: 'warning',
              end_line: 1,
              message: "Type 'OldType' was removed",
              path: 'schema.graphql',
              start_line: 1,
              title: "Type 'OldType' was removed",
            },
            {
              annotation_level: 'warning',
              end_line: 2,
              message: expect.any(String),
              path: 'schema.graphql',
              start_line: 2,
              title: "Field 'oldQuery' (deprecated) was removed from object type 'Query'",
            },
          ],
        },
      });
    });

    it('should accept a rules list with a built-in and a custom rule', async () => {
      vi.spyOn(core, 'getInput').mockImplementation((name: string, _options) => {
        switch (name) {
          case 'github-token':
            return 'MOCK_GITHUB_TOKEN';
          case 'schema':
            return 'master:schema.graphql';
          case 'rules':
            return `
          suppressRemovalOfDeprecatedField
          example/rules/custom-rule.js
          `;
          default:
            return '';
        }
      });

      mockLoadFile
        .mockResolvedValueOnce(/* GraphQL */ `
          type Query {
            oldQuery: OldType @deprecated(reason: "use newQuery")
            newQuery: Int!
          }

          type OldType {
            field: String!
          }
        `)
        .mockResolvedValueOnce(/* GraphQL */ `
          type Query {
            newQuery: Int!
          }
        `);

      await run();

      expect(mockUpdateCheckRun).toBeCalledWith(expect.anything(), '2', {
        conclusion: CheckConclusion.Success,
        output: {
          title: 'Everything looks good',
          summary: expect.stringContaining('Found 2 changes'),
          annotations: [
            {
              annotation_level: 'warning',
              end_line: 1,
              message: "Type 'OldType' was removed",
              path: 'schema.graphql',
              start_line: 1,
              title: "Type 'OldType' was removed",
            },
            {
              annotation_level: 'warning',
              end_line: 2,
              message: expect.any(String),
              path: 'schema.graphql',
              start_line: 2,
              title: "Field 'oldQuery' (deprecated) was removed from object type 'Query'",
            },
          ],
        },
      });
    });
  });
});
