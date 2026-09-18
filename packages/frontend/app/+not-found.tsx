import React from 'react';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';

import NotFoundScreen from '@/components/NotFoundScreen';
import { SEO } from '@/components/SEO';

export default function NotFoundRoute() {
  const { t } = useTranslation();
  return (
    <>
      <SEO title={t('seo.notFound.title')} description={t('seo.notFound.description')} />
      <Stack.Screen options={{ title: t('notFound.title') }} />
      <NotFoundScreen />
    </>
  );
}
