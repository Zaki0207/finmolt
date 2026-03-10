'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
    useEffect(() => {
        console.error(error);
    }, [error]);

    return (
        <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 text-center px-4">
            <AlertTriangle className="h-16 w-16 text-destructive opacity-80" />
            <h2 className="text-2xl font-bold">Something went wrong</h2>
            <p className="text-muted-foreground max-w-sm">
                {error.message || 'An unexpected error occurred. Please try again.'}
            </p>
            <Button onClick={reset} variant="primary">Try again</Button>
        </div>
    );
}
