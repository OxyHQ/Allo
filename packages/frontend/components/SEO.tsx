import React from 'react';
import { Platform } from 'react-native';
import { usePathname } from 'expo-router';
import Head from 'expo-router/head';
import { useTranslation } from 'react-i18next';

export interface SEOProps {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  type?: 'website' | 'article' | 'profile';
}

const ORIGIN = 'https://allo.you';

/** Web document metadata for the current page. Renders nothing on native. */
export function SEO({ title, description, image, url, type = 'website' }: SEOProps) {
  const pathname = usePathname();
  const { t } = useTranslation();

  if (Platform.OS !== 'web') return null;

  const siteName = t('seo.siteName', { defaultValue: 'Allo' });
  const pageTitle = title || t('seo.defaultTitle', { defaultValue: siteName });
  const pageDescription = description || t('seo.defaultDescription', { defaultValue: '' });
  const origin = typeof window !== 'undefined' ? window.location.origin : ORIGIN;
  const fullUrl = url || `${origin}${pathname}`;
  const pageImage = image || `${ORIGIN}/og-image.png`;

  return (
    <Head>
      <title>{pageTitle}</title>
      <meta name="description" content={pageDescription} />
      <meta property="og:type" content={type} />
      <meta property="og:url" content={fullUrl} />
      <meta property="og:title" content={pageTitle} />
      <meta property="og:description" content={pageDescription} />
      <meta property="og:image" content={pageImage} />
      <meta property="og:site_name" content={siteName} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={pageTitle} />
      <meta name="twitter:description" content={pageDescription} />
      <meta name="twitter:image" content={pageImage} />
      <link rel="canonical" href={fullUrl} />
    </Head>
  );
}
