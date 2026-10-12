'use client';

import {
  Banner,
  Button,
  Checkbox,
  FormField,
  Input,
  Radio,
  RadioGroup,
  Select,
  Skeleton,
  Stepper,
  useToast,
} from '@sm/ui';
import { FileUp } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { cellApi } from '../../lib/cell-api';
import type { ApiResult } from '../../lib/client-api';
import type { DescribedObject } from '../records/fields';
import { useSetupProblem } from '../setup/use-problem';
import { ImportProgress } from './import-progress';
import { fromMapping, MappingStep, toMapping, type ColumnChoice } from './mapping-step';
import { ProgressBar } from './progress-bar';
import {
  fileTypeOf,
  STARTED,
  uploadFile,
  type ColumnMapping,
  type Created,
  type ImportAnalysis,
  type ImportJob,
  type NamedRule,
} from './types';

const STEPS = ['upload', 'headers', 'mapping', 'duplicates', 'review', 'run'] as const;
type Step = (typeof STEPS)[number];
const POLL_MS = 1500;
const NO_RULE = '__none';

/** Where a job left off: the step to resume it at. */
function stepOf(job: ImportJob): Step {
  if (STARTED.has(job.status)) return 'run';
  if (job.status === 'READY') return 'review';
  if (job.headers.length === 0) return 'upload';
  return job.mapping.length ? 'duplicates' : 'mapping';
}

/**
 * The import wizard (§7.1, §9 T6): a centred column with the stepper on top, one decision per step
 * and Back/Next in a sticky footer. The job lives on the server, so `?job=` resumes it after a
 * reload; the file goes straight to object storage through its pre-signed URL.
 */
export function ImportWizard({ object, section }: { object: string; section: string }) {
  const t = useTranslations('imports');
  const problem = useSetupProblem();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const [describe, setDescribe] = useState<DescribedObject | null>(null);
  const [step, setStep] = useState<Step>('upload');
  const [job, setJob] = useState<ImportJob | null>(null);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [choices, setChoices] = useState<ColumnChoice[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [matching, setMatching] = useState<NamedRule[] | null>(null);
  const [assignment, setAssignment] = useState<NamedRule[] | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [headerRow, setHeaderRow] = useState('1');
  const [templateName, setTemplateName] = useState('');
  const [loaded, setLoaded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const fail = (result: ApiResult<unknown>, specific: Record<string, string> = {}) => {
    setError(problem(result, specific));
    setFieldErrors(
      result.ok ? [] : (result.problem?.errors ?? []).map((e) => `${e.field}: ${e.message}`),
    );
  };
  const clear = () => {
    setError(null);
    setFieldErrors([]);
  };

  const remember = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params.toString());
      next.set('job', id);
      router.replace(`${pathname}?${next.toString()}`);
    },
    [params, pathname, router],
  );

  // The object's fields, the rules the caller may choose from, and a job to resume.
  useEffect(() => {
    void cellApi<DescribedObject>('GET', `/v1/objects/${object}/describe`).then((r) => {
      if (r.ok) setDescribe(r.data);
    });
    const rules = (path: string, set: (rules: NamedRule[]) => void) =>
      void cellApi<{ items: NamedRule[] }>('GET', path).then((r) => {
        // Without view_setup the rules are not listed: the choices simply are not offered.
        set(r.ok ? r.data.items.filter((x) => x.object === object && x.active !== false) : []);
      });
    rules('/v1/setup/matching-rules', setMatching);
    rules('/v1/setup/assignment-rules', setAssignment);
  }, [object]);

  useEffect(() => {
    const id = params.get('job');
    if (!id || loaded) {
      setLoaded(true);
      return;
    }
    setLoaded(true);
    void cellApi<ImportJob>('GET', `/v1/imports/${id}`).then((r) => {
      if (!r.ok) return;
      setJob(r.data);
      setChoices(fromMapping(r.data.mapping, r.data.headers.length));
      setStep(stepOf(r.data));
    });
  }, [params, loaded]);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  // While the worker has the job (dry run or run), follow it.
  // While the worker runs the dry run, follow the job (ImportProgress follows a real run).
  const jobId = job?.id;
  const testing = step === 'review' && busy && job?.status === 'UPLOADED';
  useEffect(() => {
    if (!testing || !jobId) return;
    const timer = setInterval(() => {
      void cellApi<ImportJob>('GET', `/v1/imports/${jobId}`).then((r) => {
        if (!r.ok) return;
        setJob(r.data);
        if (r.data.status === 'READY') setBusy(false);
      });
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [testing, jobId]);

  const analyse = async (id: string, body: Record<string, unknown> = {}) => {
    const r = await cellApi<ImportAnalysis>('POST', `/v1/imports/${id}/analyse`, body);
    if (!r.ok) {
      fail(r);
      return null;
    }
    setAnalysis(r.data);
    setJob(r.data.job);
    setSheet(r.data.job.sheet);
    setHeaderRow(String(r.data.job.headerRow));
    return r.data;
  };

  const upload = async () => {
    if (!file) return;
    const type = fileTypeOf(file.name);
    if (!type) {
      setError(t('upload.wrongType'));
      return;
    }
    clear();
    setBusy(true);
    setUploaded(0);
    const created = await cellApi<Created>('POST', '/v1/imports', {
      object,
      fileName: file.name,
      fileType: type,
      fileSize: file.size,
    });
    if (!created.ok) {
      setBusy(false);
      setUploaded(null);
      fail(created, { service_unavailable: t('upload.noStorage') });
      return;
    }
    const status = await uploadFile(
      created.data.upload.url,
      file,
      created.data.upload.headers,
      setUploaded,
    );
    if (status < 200 || status >= 300) {
      setBusy(false);
      setUploaded(null);
      setError(t('upload.failed'));
      return;
    }
    remember(created.data.job.id);
    const read = await analyse(created.data.job.id);
    setBusy(false);
    if (!read) return;
    setChoices(fromMapping(read.suggestions, read.headers.length));
    setStep('headers');
  };

  const saveOptions = async (patch: Record<string, unknown>): Promise<boolean> => {
    if (!job) return false;
    const r = await cellApi<ImportJob>('PATCH', `/v1/imports/${job.id}`, {
      ...patch,
      version: job.version,
    });
    if (!r.ok) {
      fail(r);
      return false;
    }
    setJob(r.data);
    return true;
  };

  const next = async () => {
    clear();
    if (step === 'upload') return upload();
    if (!job) return;
    setBusy(true);
    try {
      if (step === 'headers') {
        // Headers are read again only when the sheet or header row changed.
        if (!analysis || sheet !== job.sheet || Number(headerRow) !== job.headerRow) {
          const read = await analyse(job.id, {
            ...(sheet ? { sheet } : {}),
            headerRow: Math.max(1, Math.min(100, Number(headerRow) || 1)),
          });
          if (!read) return;
          setChoices(fromMapping(read.suggestions, read.headers.length));
        }
        setStep('mapping');
      } else if (step === 'mapping') {
        if (toMapping(choices).length === 0) {
          setError(t('mapping.none'));
          return;
        }
        if (await saveOptions({ mapping: toMapping(choices) })) setStep('duplicates');
      } else if (step === 'duplicates') {
        if (job.duplicateMode !== 'CREATE' && !job.matchingRuleId) {
          setError(t('duplicates.needRule'));
          return;
        }
        setStep('review');
      } else if (step === 'review') {
        const r = await cellApi<ImportJob>('POST', `/v1/imports/${job.id}/start`);
        if (!r.ok) {
          fail(r);
          return;
        }
        setJob(r.data);
        setStep('run');
      }
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    clear();
    const i = STEPS.indexOf(step);
    if (i > 0) setStep(STEPS[i - 1] ?? 'upload');
  };

  const dryRun = async () => {
    if (!job) return;
    clear();
    const r = await cellApi<ImportJob>('POST', `/v1/imports/${job.id}/dry-run`);
    if (!r.ok) {
      fail(r);
      return;
    }
    setJob(r.data);
    setBusy(true);
  };

  const saveTemplate = async () => {
    if (!analysis) return;
    const r = await cellApi('POST', '/v1/import-templates', {
      object,
      name: templateName.trim(),
      headers: analysis.headers,
      mapping: toMapping(choices),
    });
    if (r.ok) {
      toast({ tone: 'success', title: t('mapping.templateSaved') });
      setTemplateName('');
    } else fail(r, { conflict: t('mapping.templateTaken') });
  };

  const applyTemplate = async (id: string) => {
    const r = await cellApi<{ items: { id: string; mapping: ColumnMapping[] }[] }>(
      'GET',
      `/v1/import-templates?object=${object}`,
    );
    const found = r.ok ? r.data.items.find((x) => x.id === id) : undefined;
    if (found && analysis) setChoices(fromMapping(found.mapping, analysis.headers.length));
  };

  if (!describe || !loaded)
    return (
      <div aria-busy="true" className="mx-auto flex w-full max-w-[720px] flex-col gap-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );

  const index = STEPS.indexOf(step);
  const started = job ? STARTED.has(job.status) : false;
  const labels = STEPS.map((key) => ({ key, label: t(`steps.${key}`) }));
  const nextLabel =
    step === 'review'
      ? t('actions.start')
      : step === 'upload'
        ? t('actions.upload')
        : t('actions.next');

  return (
    <div className="flex min-h-full flex-col">
      <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-6 px-4 py-6">
        <div className="flex items-center justify-between gap-3">
          <Link href={`/${section}`} className="text-body-sm text-link">
            {t('backTo', { objects: describe.labelPlural })}
          </Link>
          <Link href={`/${section}/import/history`} className="text-body-sm text-link">
            {t('history.link')}
          </Link>
        </div>
        <Stepper
          steps={labels}
          current={index}
          label={t('stepsLabel')}
          completedLabel={t('stepDone')}
          currentLabel={t('stepCurrent')}
        />
        <h1 ref={heading} tabIndex={-1} className="text-title-1 text-fg outline-none">
          {t(`titles.${step}`, { objects: describe.labelPlural })}
        </h1>
        {error ? (
          <Banner tone="danger" role="alert">
            {error}
            {fieldErrors.length ? (
              <ul className="mt-1 list-disc ps-5">
                {fieldErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : null}
          </Banner>
        ) : null}

        {step === 'upload' ? <UploadStep file={file} onFile={setFile} progress={uploaded} /> : null}

        {step === 'headers' && analysis ? (
          <div className="flex flex-col gap-4">
            {analysis.sheets.length > 1 ? (
              <FormField label={t('headers.sheet')}>
                <Select
                  options={analysis.sheets.map((s) => ({ value: s, label: s }))}
                  value={sheet ?? analysis.sheets[0] ?? ''}
                  onValueChange={setSheet}
                />
              </FormField>
            ) : null}
            <FormField label={t('headers.headerRow')} helper={t('headers.headerRowHelp')}>
              <Input
                type="number"
                min={1}
                max={100}
                className="w-28"
                value={headerRow}
                onChange={(e) => {
                  setHeaderRow(e.target.value);
                }}
              />
            </FormField>
            <SampleTable
              headers={analysis.headers}
              rows={analysis.sample}
              caption={t('headers.sample')}
            />
          </div>
        ) : null}

        {step === 'mapping' && analysis ? (
          <div className="flex flex-col gap-4">
            <p className="text-body-sm text-fg-secondary">{t('mapping.intro')}</p>
            {analysis.templates.length ? (
              <FormField label={t('mapping.template')}>
                <Select
                  placeholder={t('mapping.templatePlaceholder')}
                  options={analysis.templates.map((x) => ({ value: x.id, label: x.name }))}
                  onValueChange={(id) => void applyTemplate(id)}
                />
              </FormField>
            ) : null}
            <MappingStep
              headers={analysis.headers}
              sample={analysis.sample}
              describe={describe}
              choices={choices}
              onChange={setChoices}
            />
            <div className="flex flex-wrap items-end gap-2">
              <FormField label={t('mapping.saveTemplate')} className="w-64">
                <Input
                  value={templateName}
                  maxLength={80}
                  onChange={(e) => {
                    setTemplateName(e.target.value);
                  }}
                />
              </FormField>
              <Button
                variant="secondary"
                disabled={!templateName.trim() || toMapping(choices).length === 0}
                onClick={() => void saveTemplate()}
              >
                {t('mapping.saveTemplateAction')}
              </Button>
            </div>
          </div>
        ) : null}

        {step === 'mapping' && !analysis && job ? (
          <Button variant="secondary" onClick={() => void analyse(job.id)}>
            {t('mapping.reread')}
          </Button>
        ) : null}

        {step === 'duplicates' && job ? (
          <DuplicatesStep
            job={job}
            matching={matching}
            assignment={assignment}
            onChange={(patch) => void saveOptions(patch)}
          />
        ) : null}

        {step === 'review' && job ? (
          <ReviewStep job={job} running={busy} onDryRun={() => void dryRun()} />
        ) : null}

        {step === 'run' && job ? (
          <ImportProgress job={job} section={section} onChange={setJob} />
        ) : null}
      </div>

      {step !== 'run' ? (
        <footer className="sticky bottom-0 border-t border-line bg-surface">
          <div className="mx-auto flex w-full max-w-[720px] justify-between gap-2 px-4 py-3">
            <Button variant="secondary" onClick={back} disabled={index === 0 || busy || started}>
              {t('actions.back')}
            </Button>
            <Button
              variant="primary"
              loading={busy && step !== 'review'}
              loadingLabel={nextLabel}
              disabled={(step === 'upload' && !file) || (step === 'review' && busy)}
              onClick={() => void next()}
            >
              {nextLabel}
            </Button>
          </div>
        </footer>
      ) : null}
    </div>
  );
}

function UploadStep({
  file,
  onFile,
  progress,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  progress: number | null;
}) {
  const t = useTranslations('imports.upload');
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => {
          setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onFile(e.dataTransfer.files[0] ?? null);
        }}
        className={`flex flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center ${
          over ? 'border-primary bg-selected' : 'border-line-strong bg-subtle'
        }`}
      >
        <FileUp aria-hidden="true" className="size-8 text-fg-secondary" />
        <p className="text-body text-fg">{t('drop')}</p>
        <p className="text-caption text-fg-secondary">{t('limits')}</p>
        <input
          ref={input}
          id="import-file"
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          onChange={(e) => {
            onFile(e.target.files?.[0] ?? null);
          }}
        />
        <Button
          variant="secondary"
          onClick={() => {
            input.current?.click();
          }}
        >
          {t('choose')}
        </Button>
        <label htmlFor="import-file" className="sr-only">
          {t('choose')}
        </label>
      </div>
      {file ? (
        <p className="text-body-sm text-fg" aria-live="polite">
          {t('chosen', { name: file.name, size: Math.max(1, Math.round(file.size / 1024)) })}
        </p>
      ) : null}
      {progress !== null ? <ProgressBar value={progress} label={t('uploading')} /> : null}
    </div>
  );
}

function SampleTable({
  headers,
  rows,
  caption,
}: {
  headers: string[];
  rows: string[][];
  caption: string;
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full border-collapse text-body-sm">
        <caption className="px-3 py-2 text-start text-caption text-fg-secondary">{caption}</caption>
        <thead>
          <tr className="border-y border-line bg-subtle">
            {headers.map((h, i) => (
              <th
                key={`${String(i)}-${h}`}
                scope="col"
                className="whitespace-nowrap px-3 py-2 text-start font-medium text-fg"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line-subtle last:border-b-0">
              {headers.map((_, j) => (
                <td key={j} className="max-w-48 truncate px-3 py-2 text-fg-secondary">
                  {r[j] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DuplicatesStep({
  job,
  matching,
  assignment,
  onChange,
}: {
  job: ImportJob;
  matching: NamedRule[] | null;
  assignment: NamedRule[] | null;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const t = useTranslations('imports.duplicates');
  const noRules = matching !== null && matching.length === 0;
  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-label text-fg">{t('mode')}</legend>
        <RadioGroup
          value={job.duplicateMode}
          onValueChange={(v) => {
            onChange({ duplicateMode: v });
          }}
        >
          <Radio value="SKIP" label={t('skip')} disabled={noRules} />
          <Radio value="UPDATE" label={t('update')} disabled={noRules} />
          <Radio value="CREATE" label={t('create')} />
        </RadioGroup>
        {noRules ? <p className="text-caption text-fg-secondary">{t('noRules')}</p> : null}
      </fieldset>
      {job.duplicateMode !== 'CREATE' && matching?.length ? (
        <FormField label={t('rule')} required>
          <Select
            placeholder={t('rulePlaceholder')}
            options={matching.map((r) => ({ value: r.id, label: r.name }))}
            {...(job.matchingRuleId ? { value: job.matchingRuleId } : {})}
            onValueChange={(v) => {
              onChange({ matchingRuleId: v });
            }}
          />
        </FormField>
      ) : null}
      <div className="flex flex-col gap-3">
        <Checkbox
          label={t('assign')}
          checked={job.runAssignment}
          onCheckedChange={(checked) => {
            onChange({ runAssignment: checked === true });
          }}
        />
        {job.runAssignment && assignment?.length ? (
          <FormField label={t('assignRule')} helper={t('assignRuleHelp')}>
            <Select
              options={[
                { value: NO_RULE, label: t('defaultRule') },
                ...assignment.map((r) => ({ value: r.id, label: r.name })),
              ]}
              value={job.assignmentRuleId ?? NO_RULE}
              onValueChange={(v) => {
                onChange({ assignmentRuleId: v === NO_RULE ? null : v });
              }}
            />
          </FormField>
        ) : null}
      </div>
    </div>
  );
}

function ReviewStep({
  job,
  running,
  onDryRun,
}: {
  job: ImportJob;
  running: boolean;
  onDryRun: () => void;
}) {
  const t = useTranslations('imports.review');
  const td = useTranslations('imports.duplicates');
  const mode = { SKIP: td('skip'), UPDATE: td('update'), CREATE: td('create') }[job.duplicateMode];
  const row = (label: string, value: ReactNode) => (
    <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-3 py-1.5">
      <dt className="text-fg-secondary">{label}</dt>
      <dd className="text-fg">{value}</dd>
    </div>
  );
  return (
    <div className="flex flex-col gap-6">
      <dl className="divide-y divide-line-subtle text-body-sm">
        {row(t('file'), job.fileName)}
        {row(t('columns'), t('columnsValue', { n: job.mapping.length, of: job.headers.length }))}
        {row(t('duplicates'), mode)}
        {row(t('assignment'), job.runAssignment ? t('yes') : t('no'))}
      </dl>
      <div className="flex flex-col gap-3 rounded-md border border-line p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-title-3 text-fg">{t('dryRun')}</h2>
            <p className="text-caption text-fg-secondary">{t('dryRunHint')}</p>
          </div>
          <Button
            variant="secondary"
            loading={running}
            loadingLabel={t('dryRunning')}
            onClick={onDryRun}
          >
            {job.dryRun ? t('dryRunAgain') : t('dryRunAction')}
          </Button>
        </div>
        {job.dryRun ? (
          <div className="flex flex-col gap-3" aria-live="polite">
            <p className="text-body-sm text-fg">
              {t('dryRunResult', {
                rows: job.dryRun.rows,
                created: job.dryRun.created,
                updated: job.dryRun.updated,
                skipped: job.dryRun.skipped,
                failed: job.dryRun.failed,
              })}
            </p>
            {job.dryRun.problems.length ? (
              <table className="w-full border-collapse text-body-sm">
                <caption className="sr-only">{t('problems')}</caption>
                <thead>
                  <tr className="border-b border-line text-caption text-fg-secondary">
                    <th scope="col" className="py-1.5 text-start font-medium">
                      {t('row')}
                    </th>
                    <th scope="col" className="py-1.5 text-start font-medium">
                      {t('outcome')}
                    </th>
                    <th scope="col" className="py-1.5 text-start font-medium">
                      {t('reasons')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {job.dryRun.problems.slice(0, 20).map((p) => (
                    <tr key={p.row} className="border-b border-line-subtle">
                      <td className="py-1.5 tabular">{p.row}</td>
                      <td className="py-1.5">
                        {p.status === 'FAILED' ? t('failed') : t('skipped')}
                      </td>
                      <td className="py-1.5 font-mono text-caption">{p.errors.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
