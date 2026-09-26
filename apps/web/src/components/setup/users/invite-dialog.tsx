'use client';

import { Button, Combobox, Dialog, FormField, Input, useToast } from '@sm/ui';
import { useTranslations } from 'next-intl';
import { useState, type SyntheticEvent } from 'react';

import { fieldCodes } from '../../../lib/client-api';
import { cellApi } from '../../../lib/cell-api';
import { EMAIL } from '../../../lib/validation';
import { UserPicker, useSetupOptions } from '../pickers';
import { useSetupProblem } from '../use-problem';

/** Invite a person (§6.1): a pending user and a 7-day link by email. */
export function InviteDialog({ onClose }: { onClose: (invited: boolean) => void }) {
  const t = useTranslations('setup.users.inviteDialog');
  const td = useTranslations('setup.users.detail');
  const tc = useTranslations('common');
  const ta = useTranslations('auth.errors');
  const problem = useSetupProblem();
  const toast = useToast();
  const { profiles, units } = useSetupOptions();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [profileId, setProfileId] = useState('');
  const [orgUnitId, setOrgUnitId] = useState('');
  const [managerId, setManagerId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dirty = Boolean(email || name || title || profileId || orgUnitId || managerId);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!EMAIL.test(email.trim())) next.email = ta('invalidEmail');
    if (!name.trim()) next.name = ta('required');
    if (!profileId) next.profileId = t('profileRequired');
    setErrors(next);
    if (Object.keys(next).length) return;
    setPending(true);
    const result = await cellApi('POST', '/v1/invitations', {
      email: email.trim(),
      name: name.trim(),
      profileId,
      orgUnitId: orgUnitId || null,
      managerId,
      title: title.trim() || null,
    });
    setPending(false);
    if (result.ok) {
      toast({ tone: 'success', title: t('sent', { email: email.trim() }) });
      onClose(true);
      return;
    }
    const codes = fieldCodes(result);
    if (codes.email) setErrors({ email: ta('invalidEmail') });
    setFormError(problem(result, { conflict: t('emailTaken') }));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose(false);
      }}
      title={t('title')}
      description={t('description')}
      closeLabel={tc('actions.close')}
      dirty={dirty}
      discardCopy={{
        title: td('discardTitle'),
        body: td('discardBody'),
        confirm: td('discard'),
        cancel: td('keepEditing'),
      }}
      footer={
        <>
          <Button
            onClick={() => {
              onClose(false);
            }}
          >
            {tc('actions.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="invite-user" disabled={pending}>
            {t('submit')}
          </Button>
        </>
      }
    >
      <form
        id="invite-user"
        noValidate
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-4"
      >
        {formError ? (
          <p role="alert" className="text-body-sm text-danger">
            {formError}
          </p>
        ) : null}
        <FormField label={t('email')} error={errors.email} required>
          <Input
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
        </FormField>
        <FormField label={t('name')} error={errors.name} required>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </FormField>
        <FormField label={t('profile')} error={errors.profileId} required>
          <Combobox
            options={profiles ?? []}
            loading={profiles === null}
            loadingText={tc('states.loading')}
            value={profileId}
            onValueChange={setProfileId}
            placeholder={t('profile')}
            searchPlaceholder={tc('search.placeholder')}
            emptyText={tc('search.noResults')}
          />
        </FormField>
        <FormField label={t('orgUnit')}>
          <Combobox
            options={units ?? []}
            loading={units === null}
            loadingText={tc('states.loading')}
            value={orgUnitId}
            onValueChange={setOrgUnitId}
            placeholder={t('orgUnit')}
            searchPlaceholder={tc('search.placeholder')}
            emptyText={tc('search.noResults')}
          />
        </FormField>
        <FormField label={t('manager')}>
          <UserPicker value={managerId} onChange={setManagerId} placeholder={t('manager')} />
        </FormField>
        <FormField label={t('jobTitle')}>
          <Input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
            }}
          />
        </FormField>
      </form>
    </Dialog>
  );
}
