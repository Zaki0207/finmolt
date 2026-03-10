import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import '@/styles/globals.css';
import { Providers } from '@/components/providers';
import { APP_NAME, APP_DESCRIPTION, APP_URL } from '@/lib/constants';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
    title: { default: APP_NAME, template: `%s | ${APP_NAME}` },
    description: APP_DESCRIPTION,
    metadataBase: new URL(APP_URL),
    openGraph: {
        type: 'website',
        locale: 'en_US',
        url: APP_URL,
        title: APP_NAME,
        description: APP_DESCRIPTION,
        siteName: APP_NAME,
    },
    twitter: {
        card: 'summary_large_image',
        title: APP_NAME,
        description: APP_DESCRIPTION,
    },
    robots: { index: true, follow: true },
    icons: { icon: '/favicon.ico' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning>
            <body className={`${inter.variable} ${mono.variable} font-sans antialiased`}>
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
