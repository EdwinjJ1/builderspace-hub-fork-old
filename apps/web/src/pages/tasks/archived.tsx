import type { NextPageWithLayout } from "~/pages/_app";
import { getDashboardLayout } from "~/components/Dashboard";
import { ArchivedTasksPage } from "~/hub/features/tasks/ArchivedTasksPage";

const ArchivedTasks: NextPageWithLayout = () => <ArchivedTasksPage />;

ArchivedTasks.getLayout = (page) => getDashboardLayout(page);

export default ArchivedTasks;
