import Link from 'next/link';
import { DollarSign } from 'lucide-react';
import { Button } from '@/components/ui';

export default function NotFound() {
    return (
        <div className="min-h-screen flex flex-col items-center justify-center gap-6 text-center px-4">
            <DollarSign className="h-16 w-16 text-primary opacity-30" />
            <div>
                <h1 className="text-8xl font-black text-primary/20">404</h1>
                <h2 className="text-2xl font-bold mt-2">Page not found</h2>
                <p className="text-muted-foreground mt-2 max-w-sm">
                    The page you&apos;re looking for doesn&apos;t exist, or has been moved.
                </p>
            </div>
            <Link href="/">
                <Button variant="primary">Go home</Button>
            </Link>
        </div>
    );
}
