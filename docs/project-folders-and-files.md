# Project folders, Files and permissions

## Choose an existing folder or create a project

Open the folder/project button beside the recent projects list or in the top
bar. The folder path in the bottom bar opens the same browser for changing the
working directory. These folders are on the machine running the UI server. For
a local Windows deployment that is your PC; a remote deployment browses the
server's filesystem.

Use **Existing folder** to enter folders, click path breadcrumbs, go up, filter
folder names or use Home/current-project/additional-root shortcuts. You can also
paste an absolute path and click **Browse** or press Enter to inspect it. Click
**Select** beside a folder or **Select this folder** to open the project.

Use **New project**, browse to its parent, enter a name and check the full path
preview. Folder-row buttons choose a parent in this mode. **Create and open**
creates the named child through the existing server permission checks. The
virtual This PC view is not a valid parent. Creation needs an explicit Create
allowance for the target path; merely selecting a parent does not grant it.

The browser uses the existing permission-checked directory completion. An empty
list can mean no subfolders, a nonexistent/unavailable path or blocked Read
access. It does not bypass that policy. When ancestor folders are blocked, paste
the precise allowed folder path and use Browse rather than granting access to
the whole drive just to navigate there.

## What the Files panel does

The right-side Files panel lists the current project's files and directories.
Click folders to navigate and files to preview. Its Root shortcut returns to the
project; its path bar and additional roots help navigate other allowed locations.
Right-click actions include file/folder creation, rename, copy, deletion and
transfer. Each operation still requires its corresponding filesystem permission.

Reference/attachment controls can place a file or folder into the chat composer.
A path reference lets the agent request the content on demand. Displaying the
Files list does not automatically send all file contents to the model. Check the
actual read/tool card when asking the agent to inspect something.

## Allow reading a specific location

For example, to allow only your local test project's contents:

1. Open **Settings → Filesystem access → Add path rule**.
2. Enter the absolute path:
   `C:\Users\LUIZ\Pictures\Llama etc\test-project`.
3. Set **Read → Allow**. Set **Create, Write, Edit, Delete and Execute → Block**
   for read-only access. Leave the default decisions blocked.
4. Click **Save**. Open that folder in Files or reference its absolute path in a
   chat, then ask the agent to read a named file. The read tool must be enabled.

A folder rule applies to that folder and descendants. A more specific nested
rule can block a private subfolder. Use a file's absolute path to scope a rule
to one file. Filesystem rules are shared by authenticated clients on this UI
instance; they are not private per-account grants.

For the current project, **Read only → Apply to this project** grants reading
and blocks mutations/execution at that root while preserving unrelated and
nested rules. **Development** allows Read/Create/Write/Edit and asks before
Delete/Execute. Review the scope before applying either preset.

**Ask** requests approval on supported agent operations. The Files browser and
previews require **Allow**; they do not issue interactive Ask approvals. Selecting
a project, adding a navigation root or choosing a folder does not grant access.
Other tool, conversation and plugin restrictions still apply, and Windows must
also permit the server process to access the location.
