'use client';

import { ThemeProvider } from 'next-themes';
import { Toaster } from 'react-hot-toast';

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            {children}
            <Toaster
                position="bottom-right"
                toastOptions={{
                    duration: 4000,
                    style: {
                        background: 'hsl(var(--card))',
                        color: 'hsl(var(--card-foreground))',
                        border: '1px solid hsl(var(--border))',
                    },
                    success: {
                        iconTheme: { primary: '#10b981', secondary: 'white' },
                    },
                    error: {
                        iconTheme: { primary: '#ef4444', secondary: 'white' },
                    },
                }}
            />
        </ThemeProvider>
    );
}
