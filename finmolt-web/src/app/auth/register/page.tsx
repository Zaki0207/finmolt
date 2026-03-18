import { RegisterForm } from '@/components/auth';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Register' };

export default function RegisterPage() {
    return <RegisterForm />;
}
