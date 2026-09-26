import { useDialogControl } from '@oxy.so/bloom/dialog';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { RiPaletteLine } from '@oxy.so/bloom/icons/RiPaletteLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiSmartphoneLine } from '@oxy.so/bloom/icons/RiSmartphoneLine';
import { RiTranslate2 } from '@oxy.so/bloom/icons/RiTranslate2';
import { RiUploadCloud2Line } from '@oxy.so/bloom/icons/RiUploadCloud2Line';
import { SettingsModal, type SettingsNavGroup } from '@oxy.so/bloom/settings-modal';
import { toast } from '@oxy.so/bloom/toast';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlloSettingsContext } from './context';
import { GeneralSettings } from './GeneralSettings';
import Appearance from './pages/appearance';
import Backup from './pages/backup';
import Devices from './pages/devices';
import Language from './pages/language';
import Privacy from './pages/privacy';
import Blocked from './pages/privacy/blocked';
import HiddenWords from './pages/privacy/hidden-words';
import ProfileVisibility from './pages/privacy/profile-visibility';
import Restricted from './pages/privacy/restricted';

export function AlloSettingsProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const control = useDialogControl();
  const [page, setPage] = useState('general');
  const [initialView, setInitialView] = useState<'navigation' | 'page'>('navigation');
  const phrasePending = useRef(false);
  const [openRequest, setOpenRequest] = useState(0);
  const openedRequest = useRef(0);
  // Opening reads the modal's latest props; commit the destination first.
  useEffect(() => {
    if (openRequest === openedRequest.current) return;
    openedRequest.current = openRequest;
    control.open();
  }, [control, openRequest]);
  const canLeave = useCallback(() => {
    if (!phrasePending.current) return true;
    toast.error(t('backup.phrase.mustConfirm'));
    return false;
  }, [t]);
  const open = useCallback(
    (next?: string) => {
      if (!canLeave()) return;
      setPage(next ?? 'general');
      setInitialView(next ? 'page' : 'navigation');
      setOpenRequest((request) => request + 1);
    },
    [canLeave],
  );
  const close = useCallback(
    (afterClose?: () => void) => {
      if (canLeave()) control.close(afterClose);
    },
    [canLeave, control],
  );
  const setPhrasePending = useCallback((pending: boolean) => {
    phrasePending.current = pending;
  }, []);
  const value = useMemo(() => ({ open, close, setPhrasePending }), [open, close, setPhrasePending]);
  const groups: SettingsNavGroup[] = [
    {
      label: t('settings.title'),
      items: [
        {
          key: 'general',
          page: 'general',
          label: t('settings.sections.account'),
          icon: RiSettings3Line,
        },
        {
          key: 'appearance',
          page: 'appearance',
          label: t('settings.preferences.appearance'),
          icon: RiPaletteLine,
        },
        {
          key: 'language',
          page: 'language',
          label: t('settings.preferences.language'),
          icon: RiTranslate2,
        },
        {
          key: 'privacy',
          page: 'privacy',
          label: t('settings.privacy.title'),
          icon: RiLockLine,
        },
        {
          key: 'devices',
          page: 'devices',
          label: t('devices.title'),
          icon: RiSmartphoneLine,
        },
        {
          key: 'backup',
          page: 'backup',
          label: t('backup.title'),
          icon: RiUploadCloud2Line,
        },
      ],
    },
  ];
  return (
    <AlloSettingsContext.Provider value={value}>
      {children}
      <SettingsModal
        control={control}
        onBeforeLeave={canLeave}
        groups={groups}
        page={page}
        onPageChange={(next) => {
          if (canLeave()) setPage(next);
        }}
        defaultPage="general"
        initialView={initialView}
        labels={{
          dialog: t('settings.title'),
          back: t('common.back'),
          close: t('common.close'),
        }}
        pages={{
          general: {
            title: t('settings.sections.account'),
            content: <GeneralSettings />,
          },
          appearance: {
            title: t('settings.preferences.appearance'),
            content: <Appearance />,
          },
          language: {
            title: t('settings.preferences.language'),
            content: <Language />,
          },
          privacy: { title: t('settings.privacy.title'), content: <Privacy /> },
          devices: { title: t('devices.title'), content: <Devices /> },
          backup: { title: t('backup.title'), content: <Backup /> },
          'privacy-blocked': {
            title: t('settings.privacy.blockedUsers'),
            content: <Blocked />,
          },
          'privacy-restricted': {
            title: t('settings.privacy.restrictedProfiles'),
            content: <Restricted />,
          },
          'privacy-hidden-words': {
            title: t('settings.privacy.hiddenWords'),
            content: <HiddenWords />,
          },
          'privacy-profile-visibility': {
            title: t('settings.privacy.privateProfile'),
            content: <ProfileVisibility />,
          },
        }}
      />
    </AlloSettingsContext.Provider>
  );
}
