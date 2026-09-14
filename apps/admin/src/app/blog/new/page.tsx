import type { Metadata } from 'next';
import { Card, PageHeader } from '@health/ui';
import { currentUser } from '@/lib/session';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { BlogPostForm } from '@/components/blog-post-form';

export const metadata: Metadata = { title: 'New post' };

export default async function NewBlogPostPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'BLOG_WRITE')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="BLOG_WRITE" />
      </ConsoleShell>
    );
  }

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="New post"
          description="Saved as a draft. Nothing is published until somebody publishes it."
        />
        <Card>
          <BlogPostForm />
        </Card>
      </div>
    </ConsoleShell>
  );
}
