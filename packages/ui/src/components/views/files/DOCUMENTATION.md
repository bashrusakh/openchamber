# File tree loading and visibility

`FilesView` and `SidebarFilesTree` keep directory snapshots in component state.
`DirectoryRequests` owns shared in-flight reads and supersession. Repeated
same-path callers await the same request; an explicit mutation refresh can
replace it. Scope changes and unmount clear the coordinator, so old completions
cannot publish or remove a newer request's slot. Callers also check runtime
identity at completion.

Directory arrays retain their references when every rendered field and ordering
matches. `fileTreeStatus.ts` builds path and ancestor indexes once per Git
snapshot. Open-file membership has its own set, so changing tabs does not
rebuild the Git index.

Directory listings follow the "Show gitignored files" setting: `SidebarFilesTree`,
`FilesView`, and the mobile `MobileFilesSurface` ask the runtime for
`respectGitignore` unless the user has chosen to show gitignored entries, so the
server's `git check-ignore` filter decides what appears inside a Git repository.
Outside a repository no entries are ignored, so the hardcoded `node_modules`
name filter remains as a fallback. Search already follows the same setting.

## Searching

The field above the sidebar tree searches file names, as it always did. Where
the runtime has `files.searchContents` (web and desktop; VS Code has its own
search and the mobile browser keeps name search), the search icon is a menu
that switches the field to file contents. In that mode the placeholder changes,
a `.*` toggle at the end of the field makes the query a regular expression, and
the results replace the tree as one card per matching line: the file and its
folder on top with the line number, the line below with the matches marked and
an ellipsis where the server cut its start. A click opens the file at that line
as a preview, a double-click as a pinned tab (`openContextFileAtLine` with
`preview`), and a card drags into the chat like a name result. The hook
(`useFileContentSearch`) sends the debounced query with the tree's hidden and
gitignored settings, aborts the request a new query replaces so the server ends
its ripgrep process, and never lets a late answer land. "Showing the first N
matches" follows the list when the server's limit was hit, and the row says so
when the server stopped at its deadline, when the regular expression is invalid
(with ripgrep's reason), when the server has no ripgrep, or when the search
failed; none of these is shown as an empty result. The server side is in
`packages/web/server/lib/fs/DOCUMENTATION.md`.

Desktop `FilesView` in editor-only mode neither loads nor constructs its unused
tree. In the context panel the panel's tab strip owns the open files: closing
a file from the editor (Cmd/Ctrl+W in the desktop app, which the window menu
turns into `openchamber:close-tab` through `lib/closeTabTarget.ts`, or the
unsaved-changes prompt that may come first) goes through `onCloseFile` to
`closeContextFile`, which closes that tab exactly as its close button does. Mobile retains its tree. The context panel passes actual visibility,
including the panel's open state, its active tab, and the editor toggle, to each file surface.
Hidden surfaces retain drafts, loaded content and scroll state. They stop
directory and file metadata polling; reopening checks freshness once before
normal polling resumes. Autosave is independent of visibility.

Background polling never supersedes an in-flight directory read. Explicit
refresh after file mutations does. Each directory failure remains local and
preserves its previous successful snapshot.

Opening a file outside the workspace reads it directly through the active
runtime, in both editor-only and full Files modes. Chat navigation and file
loading do not request native file grants. Server-backed text reads and metadata
requests have a 30-second deadline, including response-body reads, so a stalled
request reaches the existing error handler instead of leaving loading pending.

A file that cannot be read, a missing one included, stays selected and shows
the read error; the host's tab still names that path, so the editor never falls
back to another open file. A pending line jump or focus for that path ends
there. The metadata poll treats a file deleted while open the same way: without
unsaved edits it shows the error, with unsaved edits it keeps them. It keeps
polling a failed file and loads it again once a missing file is back; a file
that exists but fails to read is never reloaded by the poll
(`openFilePollStep`). Pruning stale open paths (`removeUnselectedOpenPath`)
never removes the path on screen.

A pending line jump (`pendingFileNavigationStep`) selects its file only until
that file has been on screen. If the user then switches tabs while it loads,
the jump leaves the other tab alone and runs when its file is selected again.
A read-only text file, one outside the workspace for example, opens in the
read-only code editor, because the selection effect resets the text mode after
the effect that switches read-only files to the view mode; the jump runs there.
If no editor is on screen the jump ends, so the waiting mask never hides a
loaded file.

Sidebar root/runtime changes remount the scoped tree. Its bounded module cache
provides continuity between mounts; request cancellation for collapsed paths
stops queued batches, while already-started reads may populate the same-scope
cache. Runtime changes and unmount invalidate those active reads.

The sidebar tree is virtualized (`@tanstack/react-virtual`): the expanded
folders flatten into one list of rows (`fileTreeRows.ts`, a folder's load error
right under it), and only rows in and near view are in the document. With every
row mounted, a large repository put thousands of elements under the context
panel, and opening the panel restyled all of them and added them to the
accessibility tree inside its animation. The dragged row and the row holding
focus stay mounted wherever they scroll, so a drag still ends and focus does
not fall to the page. Selecting a file scrolls its row into view through the
virtualizer once the row exists. Only mounted rows are in the tab order. Rows
keep an explicit height (the meta line height, the icon minimum and vertical
padding), so a font change re-measures them. Search results and the root
error are plain lists. Reopening still refreshes directory contents.

## Row look

The sidebar tree, `FilesView`'s own tree and the changes tree in `DiffView`
draw rows from `FileTreeRowParts.tsx`, so the three look the same: flat rows
indented 12px per level, one faint guide per ancestor level under its
chevron, a chevron instead of a folder icon, and the git state as a coloured
letter on the right. A blue dot before the letter marks a file open in a tab;
it no longer hides the file's git state. Change the look there, not per tree.
The JSON tree viewer (`components/ui/JsonTreeViewer.tsx`) takes the same
indent and guides and copies the chevron's look; keep the copy in step.

## Refreshing after file changes

The sidebar tree and the phone browser re-list folders when the agent changed
them, with no watcher and no timer: an idle client sends nothing. OpenCode 2.x
has no file events (`filesystem.changed` covers the repository HEAD only), so
`lib/fileTreeChanges.ts` derives changes from what the event stream already
carries, fed from `sync-context` and the revert actions:

- a finished `write` or `patch` names its files, so only their parent folders
  change (`toolListingChanges` in `lib/opencode/tools.ts`; `edit` never
  creates a file and counts as no change);
- a finished `shell`, `execute`, MCP or plugin call could touch anything, so
  its session waits for the step's end: the step's snapshot `files` decide.
  An empty list costs nothing (read-only commands); a non-empty or missing
  list (snapshots off, not a Git repository, a failed step) is an unknown
  change. The snapshot skips Git-ignored files and untracked files over 2 MB;
- a finished user shell command, staging a revert and clearing one are
  unknown changes.

`useFileTreeChanges` collects changes for two seconds after the first one and
delivers them as one batch, so a surface re-lists at most once per two seconds
however fast the agent works; it holds the batch while the window is hidden.
A folder whose last listing had more than 1000 entries
(`AUTO_RELIST_MAX_ENTRIES`) is never re-listed on its own, because each
re-list resends the whole listing; the refresh button and expanding it still
read it. The sidebar drops changes while its tab is
hidden, because reopening re-lists everything anyway; the phone browser holds
them and reloads the folder on screen when the drawer shows it again, keeping
the listing if that reload fails. In the sidebar a listing on screen reloads
(forced, superseding an in-flight read); a loaded folder out of sight is only
forgotten so expanding it reads it again; a new folder re-lists its nearest
loaded ancestor. An unknown change re-lists the root and every expanded folder
on screen. Changes made outside the agent (an editor, a terminal) still need
the refresh button or reopening the tab. VS Code has no file tree, so nothing
subscribes there. Desktop `FilesView` keeps its own 8-second poll of expanded
folders.

## Artifact previews

`previews/` holds what the viewer shows instead of text: `ImageArtifact`
(natural dimensions; fit, which never upscales, or a zoom from 10% to 1600%
through −/+ steps, Ctrl/⌘ + wheel or trackpad pinch, Safari gesture events,
a two-finger touch pinch, and double-click between fit and 1:1, anchored at
the pointer; a zoomed image larger than the viewer pans by mouse drag;
`imageZoom.ts` holds the scale math; round arrows fixed to the viewer's
edges, and the arrow keys while the viewer has focus and the image is at fit,
show the previous and next image of the same folder, see below),
`MediaArtifact` (native audio/video
element, duration and dimensions once metadata loads, a stated failure when
the runtime cannot decode the codec), `FontArtifact` (a specimen under a
throwaway `FontFace` family removed when the tab closes), `TableArtifact`
(CSV/TSV through `delimitedText.ts`, capped rows stated in the meta line, the
rows and columns in view mounted unless the grid of the file is small enough
to be kept whole), and `BinaryArtifact` (name, type,
size, download; never a decode attempt).
`FilesView.renderArtifactPreview` is the single switch both the docked and
the fullscreen viewer use. SVG, Mermaid (`.mmd`) and delimited files are text
with an artifact view: each has a per-path preview/source toggle, and opens
in preview regardless of the text-first setting because an agent-produced
artifact is opened to be looked at.

The table preview mounts only the rows and the columns in view, unless the
grid of the file is small enough to be kept whole. A wide export holds far
more cells than a screen can show, and mounting all of them froze the viewer
for seconds: 2,000 rows with 50 columns ask for 100,000 cells. The rows
outside the window are carried by spacer rows that take their height, and
the columns beside the window by a spacer cell that spans them, so the table
keeps its own layout, its column widths and its text selection.
`tableLayout.ts` holds the model: the width of every column, the range of
rows and columns a scroll position lands on, and the size of the grid of a
file. What has to stay true:

- the preview is a real `<table>` with a sticky `<thead>`, because the table
  semantics and the native text selection depend on it;
- the row cap of the parser and the notice about it in the meta line stay as
  they are;
- a file whose grid is small enough is kept whole and a file whose grid is
  large enough is windowed. The decision is a property of the file, so the
  same file is kept whole in a narrow panel and in a wide one;
- the mounted cells stay bounded by the viewport on both axes, so the cost of
  drawing a file does not grow with the file. The files that are kept whole
  are the exception, and the limit bounds what they cost. Three things grow
  with the file anyway: the parse of the file, the walks over the kept cells
  (the check for plain latin, the walk for the characters outside latin and
  the measurement of the widths, which the first file of a session pays for
  twice), and the `<col>` the table holds for every column of the file,
  because the parser does not bound the number of columns;
- the widths of the columns are measured from the data and from the font, and
  a resize of the panel does not measure them again;
- the column widths stay the same while scrolling, and a column is as wide as
  the text the browser lays out for its longest value, so nothing that fits
  today is cut short;
- only the rows and the columns in view are in the document, so the browser's
  find-in-page, a selection of the whole file and a screen reader see the
  window and not the file. A value outside the window is in the document only
  while the window is over it. A file that is kept whole holds every row and
  every column of it, so those three see the file;
- the table states how many rows and how many columns it has, and every
  mounted row and cell states where it sits in the file, so a screen reader
  is told the size of the table and not the size of the window;
- a right-to-left table keeps its columns in the order the file has them,
  with the first column on the right. Its scroll offset is read the way the
  browser reports it: 0 at the right edge of the box, and negative from
  there as the box is scrolled towards its left edge;
- the columns in view are the ones the viewer can see, in the direction the
  document is laid out in at the time;
- a new file mounts its own rows and columns from the first commit, so the
  window of the file before it is never in the document;
- the rule under a row runs across the whole width of the table, and the
  stripe of a row runs behind the columns beside the window, so the table
  looks the way it did when every cell of the file was in the document;
- the header row is as tall as a row of the body, so the header cells in view
  cannot change its height and the content below the header does not jump
  while the window moves over columns whose header is empty;
- a file is measured when it opens, whatever file was open before it. A file
  without columns has no table to measure, so the next file is measured from
  scratch.

How much each of them costs was measured on one machine, so the figures below
describe that machine and say nothing about the code itself. A 2,000-row file
with 50 columns took 66 ms of parse, 15 ms for the latin check and 6 ms for
the measurement of the widths, about 90 ms of main-thread work when the file
opens. The first file of a session pays the measurement of the widths a
second time, because the layout starts on guessed metrics, so it takes about
96 ms there. A file with 5,000 columns in 2,000 rows took 2.2 s of parse,
0.66 s for the latin check and 0.24 s for the widths, and about 3.3 s for the
first file of a session, which pays the measurement of the widths twice. The
same shape measured about 1.8 s of parse and about 1.7 s for the latin check
on another machine. The parse is the largest single item on both, but the
margin over the latin check is wide on the first machine and narrow on the
second.

A file that holds characters outside latin pays for the walk that finds them
and for the measured widths they are counted at. The same 2,000-row file with
50 columns of greek took 20 ms for the walk for the characters and 23 ms for
the measurement of the widths on another machine, against 4 ms and 4 ms for
the same file in plain latin characters. A file in plain latin characters
runs neither: the walk for the characters outside latin is only made for a
file that has them. Such a file also pays for the measurement of the widths
twice, because the characters are measured with the font after the first
commit, and the widths are counted again with them.

The widths are written in the font's own character unit, so the browser
resolves the characters against the font it has, and the padding and the
border of a cell are written from the measurement of the document. The height
of a row is measured from the document as well, and every row is given that
height, the header row included, so the mapping from a scroll offset to a row
stays exact and the last row can be reached.

### Why a small file is kept whole and a large one is windowed

The preview held every cell of the file before the windowing, and the
browser's find-in-page, a selection of the whole file and a screen reader saw
the file. The windowing took that away from every file, and it only had to
take it away from the files that are large enough for the window to matter.
So a file whose grid is small enough is held whole, and the size of the grid
is the number of cells the table holds, the header row included. The limit is
one number, `TABLE_WHOLE_GRID_CELL_LIMIT`, and the file decides: the same
file is held whole in a narrow panel and in a wide one, because a decision
that changed with the size of the panel would hold a file in one panel and
window it in the next.

The limit was measured in Chromium against the markup of the preview. The
machine was busy with other work during the measurements and the figures
moved by about a third between runs, so they are given as ranges: holding
1,000 cells took 20 to 60 ms of layout, 2,000 cells 30 to 90 ms, 4,000 cells
75 to 120 ms, 10,000 cells about 300 ms and 100,000 cells 3 to 4 s. The
rendering of the cells is on top of the layout the browser does for them. A
pause of a tenth of a second is where the viewer starts to notice one, so
2,000 cells is the largest grid whose cost stays around it. The window itself
holds about 800 cells and costs 15 to 25 ms, so holding a file of that size
whole costs little more than opening any windowed file.

### Why the walk over the cells goes over the fields a row has

The walk over the cells of a file went over every column of every row, and a
file with few fields per row and many columns paid for the whole width of the
table on every row: 2,000 rows with one field each took 25 ms to measure with
5,000 columns, 290 ms with 20,000 and 520 ms with 50,000 on a busy machine.
The walk goes over the fields a row has now, which took 1 ms, 1 ms and 2 ms
for the same three files. The widths are the same, because a row that does
not reach a column cannot narrow it.

### Why the table states its size and the place of its rows and cells

A table whose rows and columns are only partly in the document tells a
screen reader the size of the window and not the size of the file: it said
there were seven columns where the file had fifty. The table states how many
rows and columns it has with `aria-rowcount` and `aria-colcount`, and every
mounted row and cell states where it sits with `aria-rowindex` and
`aria-colindex`, counted from one and with the header row counted with the
rows. The places follow the file and not the document, so the row under the
top-left corner of the viewport carries the number its place in the file gives
it. The spacer rows and the spacer cells stand for the rows and the columns
outside the window and are hidden from the accessibility tree, so they are
counted nowhere.

The count of the rows is the number of rows the table holds and not the
number of rows the file has: the parser keeps the first rows of a large file
and the meta line says so, and a row the file has and the table does not is
no row of the table.

### Why the window is written here and not taken from `@tanstack/react-virtual`

The virtualizer in this repo positions rows in a list of its own height. A
table has no such list: its height comes from the header, the rows and the
spacer row that stands in for the rows above, and the height a row is
planned with has to match the height the rows really take, or the mapping
from a scroll offset to a row drifts and the last row cannot be reached. The
window here is a pure function of the parsed table, the measurements and the
scroll offset, which is what the tests check, and it covers both directions
of the same table at once.

### Why the model of the window is written after the commit and not during the render

The window is computed from the model of the last commit: the plan of the
columns, the measurements, the number of rows and the number of columns. A
render React throws away must not leave a plan in that model, because a
scroll event landing in that window would ask for the rows and the columns of
a table that never reached the document. The model is therefore written in
the layout effect that moves the window, and not in the body of the render.

### Why every row is the measured height and not the height its own text takes

A row whose cells are all empty has no line in it, so it is shorter than a
row with text: the padding and the border are all that is left of it. Such a
row is a real row, because a record that holds delimiters is not a blank
line, and one height for all the rows is what keeps the mapping from a
scroll offset to a row exact. A row without text is therefore as tall as a
row with text, and it carries the stripe of its own index like every other
row.

The height is measured from a probe that holds the same box a cell holds, so
the measurement does not depend on which row happens to be first in the
window. A file whose first row is empty would otherwise be planned with the
height of that row, the rows below it would sit higher than the plan says,
and the last row could not be reached at all.

The header row is given that height as well. Its height would otherwise be
the height of the tallest header cell in view, and a header cell without text
has no line in it, so the header would shrink to its padding and its border
while the window moves over the columns whose header is empty, and the content
below it would jump. A header cell holds the same box as a cell of the body,
so the height of a row is the height to give the header row.

### Why the widths of the columns are measured apart from the room of the panel

A column asks for the width of its longest value, and the room the panel has
left over is shared out over the columns afterwards. The two are measured in
two steps, because only the second one has anything to do with the panel: the
walk over the cells of the file is the expensive part, and repeating it for
every frame of a sidebar drag made the cost of a wide export grow with the
file. The widths are measured once per file and once more for every change of
the font, and a resize only shares the room out again. The first file of a
session is measured twice, because the layout starts on guessed metrics.

### Why the first file of a session is measured against guessed metrics

The layout starts on guessed metrics, because the font is only measured from
the document after the first commit, and the widths of the columns are needed
for that first commit. The measurement of the widths therefore runs against
the guesses, and the layout effect then replaces the guesses with the
measured ones, which asks for the walk over the cells again. The result of
the first walk is never painted, so it is waste. Every file after the first
one is measured once, because the metrics do not change and the memo holds.
Measuring the widths without the metrics would take the cap on a cell off the
walk over the cells and put it in a second pass, which changes the width
model. Leaving the first commit without column widths would show the table
with the wrong widths for a frame.

The characters outside latin are counted at the counted width in that first
commit as well, and the layout effect measures them with the font and counts
the widths again. A file in plain latin characters has no such characters,
and the walk that looks for them is not made for it.

### Why the latin flag is read from the kept rows and not from the file

A value of plain latin characters takes one cell per character, and a value
with characters outside latin takes the width they are measured at, so the
preview has to know which it is looking at before it measures a column. The
flag is read over the header and the rows that are kept. The measurement walks
exactly those cells, so the flag is exact for the cells that decide a width,
and a row the parser dropped is never measured, so it cannot change one.
Reading the whole file for the flag walked every row of the export for rows
that are never shown.

### Why the measurements keep the object they have

The widths of the columns are measured from the data and from what one
character and one cell cost, and the preview keeps them in a memo that runs
again when one of those inputs changes. A resize of the panel changes none of
them, but it does build a new layout, and a new object for the same numbers
would look to the memo like a change of the font and ask for the walk over
the cells of the file again, on every frame of a drag. The measurements
therefore keep the object they have while their values stay the same, and
only a new font, a new interface size or a new file measures the widths
again. The measured widths of the characters outside latin are kept the same
way: a resize measures them again in the browser, finds the same numbers and
leaves the map the preview holds as it is.

### Why the border of a cell is read on its inline end

The border of a cell sits on its inline end, which is the left edge of the
document in a right-to-left one. Reading the right edge instead counts no
border there, and the error grows with the number of columns: 500 columns
miss 500 px, which is ten columns of a wide table, and the columns the
viewer can see are then not in the document. The computed style resolves the
logical side, so the border is read as the inline end and the number of
columns does not change the answer.

A runtime that does not resolve the logical side counts no border at all,
and the error grows by a pixel with every column. The physical side the
direction of the document puts the border on is read as well, so the model
holds on a runtime that knows only the physical sides.

### Why the columns are measured in characters and not in pixels

A column is as wide as the text the browser lays out for its longest value,
and the browser's own automatic table layout can only measure that with every
cell in the document, which is what the window avoids. The width is therefore
a number of characters in the font's own unit (`ch`), which the browser
resolves against the font it actually has. A character in plain latin takes
one cell and a full-width character takes two, the way a monospace font lays
them out, and a character outside latin takes the width the browser measured
for it, or the counted width where the measurement found less room. A value
in Japanese still fits its column, and so does a value in a script the
monospace font does not cover.

### Why the characters outside latin are measured in the browser

A character the browser has no font for falls back to another one, and that
font can lay the character out wider than the monospace font of the preview.
Counting every such character as one cell made a column narrower than the
text in it, and the cell cut the value short. Counting them as two cells
would have fixed that and made every column in such a script twice as wide
as it has to be.

The characters the file uses are therefore measured in the browser: each of
them is drawn on its own in a hidden probe, and the width it takes there is
the width it is counted at. The model needs to know the width of a character
only to count a value, and the count of a value only decides the width of
its column, so a value in such a script is now as wide as the text the
browser lays out for it. A character the browser lays out narrower than the
monospace font keeps the counted width, so a column is never padded with room
the text does not need, and a character the measurement did not reach keeps
the counted width as well.

The figures here were measured in Chromium with the fonts of the application
on the machine the check ran on, where a latin character takes 7.5 px. Sixty
greek characters took 460 px in the automatic layout of the browser and 450
px in the counted width, so the tail of the value was lost. A greek letter
takes 7.797 px on its own and 7.665 px in a run of sixty, and the column of
sixty of them is 468 px wide, which covers the text and is 8 px more than it
needs. A cyrillic letter takes 7.219 px, less than a latin character, so its
column keeps the counted width of 450 px.

A character in the wide list is measured like any other character, and it
keeps at least the two cells of the counted width. A full-width character is
1em against a monospace advance of about 0.6em, so two cells leave a column
of Japanese a fifth of room to spare. A colour emoji is usually a little
wider than two latin cells, so on a platform that has a font for it the
column is a little wider than the text in it, and on a platform without one
the character falls back to a box of the width of the monospace font and
keeps the two cells of the counted width.

What the model cannot know is the width of a character the measurement did
not reach, and the width a font gives a character in the middle of a word,
such as a letter of an Arabic word, which the browser shapes.

The walk that finds the characters stops at 1,024 of them, because the list
is only used to measure them in the browser and a file with more distinct
characters than that costs more to measure than the width it gains. A
character the walk did not reach keeps the counted width.

### Why the padding and the border of a cell are written from the measurement

The width of a column is written into the `<col>` of the table, and the model
counts that width again to find out where the columns sit. The two have to
be the same number, and a width that is written as a fixed number is not:
the padding and the border of a cell come from the stylesheet, and the error
is one column wide and it grows along the row. A table of 24 columns whose
cells changed from `px-2` to `px-3` drifts by 184 px over the row, which is
nearly three of its columns, and the columns the viewer could see are then
not the ones in the document.

Both are built from one measurement of a probe that carries the classes a
cell carries, so the width the browser is given and the width the model
counts are the same number. The last column has no border on its inline end,
so its width is smaller than the others by exactly the border, and the model
counts that as well.

### Why the cap counts one layout step of room and not the exact room

A cell is capped at 32 rem, and the cap is the number of characters that fit
in the room the cell has left. The browser keeps its lengths in whole
1/64 px and rounds a text box's width to the nearest one of those steps, so
a value that needs a fraction more than the room still fits, and the text box
the measuring probe reads is rounded up to the next step, so the advance the
probe measures is a hair wider than the one the layout uses. Counting the
characters against the exact room drops one character that fits, so one step
of room is added before the count. The column then stays within a step of
the cap, which no eye can see.

### Why the direction is watched on the root element and not on the preview's size

The window holds the columns the viewer can see, and a right-to-left document
lays the table out from the other end, so a scroll offset means the opposite
of what it means in a left-to-right document. The application sets the
language's direction on the root element, and nothing about the preview's
size changes with it, so the resize observer never fires and the preview
would keep the direction it measured when it opened. The root element's
direction attribute is watched for it, and the preview measures again and
reads the scroll position with the rest of the layout, because the scroll
position follows the direction too.

### Why the probe's text is watched and it has to be a box of its own

The preview watches the probe's text for a change of the font and of the
interface size, because both decide the width of a character, the height of a
row and the padding and the border of a cell. The root element's style is not
watched instead: the app writes to it on every frame of a sidebar drag, and
the measurement would then run on every one of them.

The observer reports the content box of the element it watches, and an inline
box has no content box of its own. The browser reports an empty one for it
and never reports a resize for it, whatever the text inside it measures, so
the probe's text is an inline block: a box of its own, whose width follows
the font. The advance the preview measures is the same either way, because
the width of the text does not change with the display.

### Why the measurement runs for every file and not only when the preview opens

The measuring probe is only in the document while the file has columns, so a
file that opens without columns leaves the preview unmeasured: there is no
probe to read the font from and no observer to watch. The measurement
therefore runs again for every file, and the observers are made for the probe
that is in the document at that moment, so a font or an interface-size
change is still noticed after a file without columns.

### Why the skipped rows and columns are spacers and not placed outside the flow

A table row that is taken out of the flow lays out on its own and no longer
shares the table's columns: the header cells keep their widths while the
body cells collapse. The skipped rows stay in the flow as a spacer row that
takes their height, and the skipped columns as a spacer cell that spans
them, so the header and the body keep the same column widths.

The height of a spacer row is written on the row itself. A cell's own padding
would make the cell taller than the height it asks for, and the rows would
sit lower than the model says.

A spacer cell carries the border of a cell of the table, so the rule under a
row runs across the whole width of the table and not only across the columns
that are in view. The spacer that stands for the columns before the window is
an interior boundary and keeps the border on its inline end, and the spacer
at the end of the file is the table's own last column and keeps the missing
border. A cell takes the height of its row, so the rule of a spacer sits on
the same line as the rule of the cells beside it.

The spacer rows carry no background of their own, so the region they cover is
one flat colour where the preview stripes every row. They stand at least
five rows beyond the edges of the viewport, so the region they cover is never
on screen and the stripes of the mounted rows carry on unbroken.

### Why the striping and the last column's border follow the index

`odd:` and `last:` follow the position in the document, and a windowed table
has a document position that no longer matches the logical one. The rows are
striped and the last column keeps its missing border by their index.

Stepping through a folder's images: `FilesView` reads the shown image's folder
with the tree's hidden and gitignored settings for every image shown, so
files added or removed meanwhile count, and keeps the last listing's arrows
on screen while it reads; an image the listing leaves out gets no arrows.
`imageNeighbors.ts` picks the images before and after it in the tree's order,
wrapping at the ends. SVG counts, since it opens in the image preview. A step
opens the neighbour the way a single click in the tree does (`openContextFile`
with `preview`): on desktop one preview tab follows the steps while the tab
the user started from stays; on the phone the Files surface shows the
neighbour in place and Back still leads to the folder being browsed. The
viewer unmounts while the next image loads, so a step remembers its target and
the viewer showing it within five seconds takes the focus back for the next
key. A folder that cannot be read shows no arrows.

Non-text artifacts the browser must own (PDF, audio, video, fonts) are loaded
through `getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', …)` with
the scoped URL token; the server streams byte ranges so playback can seek.
Images keep the object-URL/data-URL path.

An HTML file's preview is untrusted content. `useHtmlPreviewUrl` asks the
server for a grant (`POST /api/fs/preview`) and loads the page from
`/api/fs/preview/<grant>/<path>`; the frame's `sandbox` has no
`allow-same-origin`, so the page runs as an opaque origin with no session and
cannot reach the app's API, DOM or terminal. Its neighbouring images, styles
and scripts load through the grant in the path. A page outside the workspace
asks for its grant with `allowOutsideWorkspace`, and the server scopes it to
the page's folder. VS Code renders `srcDoc` in the same sandbox. The server
side (read root, CORS, CSP) is described in
`packages/web/server/lib/fs/DOCUMENTATION.md`.

The preview toolbar has the browser panel's "Annotate page" toggle
(`useHtmlPreviewAnnotation`, a thin use of `components/browser/useFrameAnnotation.ts`,
which pages in the chat share) on web and desktop; phones and VS Code do not
show it. The server puts a bridge into every previewed HTML page, and
`lib/browser/previewFrameHost.ts` turns the frame into an `AnnotationHost`, so
`runAnnotationSession` runs the same overlay and the result attaches to the
composer through `useAnnotationAttach`, with an intro naming the file preview.
Before starting, the host probes the bridge; a page that never answers (it
navigated away, or its own CSP blocks inline scripts or `eval`) ends in the
"could not annotate" toast. The prompt names the file path: the preview URL
carries the grant, which is a credential and stays out of prompts. On desktop
the screenshot is the on-screen part of the frame's area of the window
(`visibleFrameArea`, `desktop_capture_page_rect`),
taken after the overlay has torn itself down; a browser cannot photograph a
frame, so on web the annotation goes without one. A reload or another file
ends a running session.

### Why a bridge in the page and not a webview

The browser panel annotates through a `<webview>`, which the app can script
directly. Showing the preview in a webview on desktop would have reused that
as is, but left web without annotation and given the Files view two preview
engines. The bridge works the same in both, and gives the app no reach into
the page that the page's own scripts lack.

The Markdown preview renders the file's raw HTML the way GitHub does
(`SimpleMarkdownRenderer allowRawHtml`): right after marked, a separate
DOMPurify instance keeps a GitHub-like allowlist (`markdownSecurity.ts`:
`picture`/`source`, `img`, `a`, `details`, `sub`/`sup`, `kbd`, aligned
blocks) and drops author styles, classes, ids, data attributes, handlers,
forms and embeds. Chat keeps raw HTML inert. A numeric `img height` becomes
an inline height, because Tailwind preflight's `height: auto` would beat the
attribute.

A Markdown file's frontmatter shows above its body (`SimpleMarkdownRenderer
frontmatter="properties"`, also used by the plan view): a YAML mapping
becomes a key/value table, lists of scalars become chips, nested values show
as YAML; TOML (`+++`), invalid YAML and non-mapping YAML show as the block
was written. The skill editor hides it (`frontmatter="hide"`) because the
description has its own field there.

`useMarkdownLocalAssets` makes a rendered Markdown file's relative images and
links work: images and `srcset` candidates are fetched through the runtime
against the file's own directory (outside the workspace when the file is) and
swapped for object URLs that are revoked with the preview; relative links
open the target file through `useUIStore.openContextFile`, which the context
panel and the mobile files surface both consume. A `<source
media="(prefers-color-scheme: …)">` follows the app theme, not the OS: the
feature is rewritten to an always-true or never-true query and re-evaluated
when the theme changes.

An agent can ask for a file to be shown (`file.open` on the managed
`openchamber` tool). The server broadcasts `openchamber:file-open-request`;
`ContextPanel` answers it with `openContextFile`, `MobileApp` additionally
opens the files drawer. VS Code has no shared file viewer and no managed
tool, so the event never reaches it.

## Canvas editors

A "canvas" is an editor with its own document model instead of the text
editor: an extension's file editor (`contributes.fileEditors`, see
`packages/sdk/DOCUMENTATION.md`). It exposes `FileCanvasHandle`
(`fileCanvas.ts`); `getContent(purpose)` returns a `FileCanvasRead`: a
snapshot, `null` for nothing yet, or a failure message. A failure fails the
save or keeps the canvas open on a source or fullscreen toggle; it never falls
back to the stale text draft.

An extension editor claims a file when an active extension's pattern matches
its name (`useGuestFileEditor`, `lib/guests/file-editors.ts`), ahead of every
built-in preview: a text editor only text files, a binary editor
(`content: "binary"`) any file, images and PDFs included. `GuestFileEditor.tsx` mounts `PluginPane
surface="file"` with a per-mount channel (`lib/guests/file-editor-channel.ts`)
holding the draft at mount; the frame gets the file on `hello` / load, answers
snapshot requests within `GUEST_REQUEST_TIMEOUT_MS`, and reports changes. VS
Code and mobile keep the extension catalog empty, so there nothing matches.

The contract is one-directional content. The frame reads the file it was
handed at mount, so `FilesView` remounts it with a `key` of path plus
`canvasRemountNonce` whenever it must adopt content it did not author (a load,
an external write, a toggle back from the source view, a discard). Its own
save adopts content without a remount so the viewport is not reset. Exactly
one instance is mounted, in the docked chain or in the fullscreen overlay;
entering or leaving fullscreen moves unsaved edits through the text draft, as
the source toggle does, and the other slot remounts from it.

`isDirty` (draft differs from file) is not proof of a user edit. The context
panel keeps one FilesView that follows the selected path, so during a file
switch the draft and the file briefly belong to different files. React to real
edits through CodeMirror transactions (`isUserEvent('input' | 'delete' | 'undo'
| 'redo' | 'move')`). Autosave refuses to write an empty draft over a non-empty
file (`shouldScheduleFileAutosave`); an explicit save still can.

Canvas edits never enter the text draft. A separate `canvasDirty` flag feeds
the shared `isDirty`, so autosave, Cmd/Ctrl+S, the unsaved-changes prompt,
`saveDraft`, and the external-change guard all see canvas edits as text edits.
Key events inside the frame never reach the host, so Cmd/Ctrl+S arrives as the
frame's `file-save` and runs the same `saveNow` as the keybind. `saveDraft`
writes the canvas snapshot when the canvas is dirty and the text draft
otherwise, in the line endings the file was loaded with. It takes one snapshot
and marks its version saved after the write; `markSaved` clears the dirty flag
at once and the frame's answer to `file-saved` sets it again when edits landed
during the write. A canvas that went away with its extension clears the flag
instead of keeping autosave writing. The frame's `edited` notices hold
autosave's timer back until the canvas has been quiet for the full delay.

A canvas never mounts over a draft it cannot take (`shouldShowFileCanvas`): a
draft over `GUEST_FILE_EDITOR_CONTENT_MAX` stays in the source view, and a
frame that cannot read the file reports `file-unsupported`, which returns the
viewer to the source view and records that mode for the path.

A binary editor has no text draft. `GuestFileEditor` reads the file's bytes at
mount (`/api/fs/raw` through `runtimeFetch`, `loadCanvasBytes`) and loads the
frame once they are here; too many bytes or a failed read fall back to the
built-in view with a toast. Its snapshot is bytes, written with
`files.uploadFile(..., { overwrite: true })`, the same atomic temp-and-rename
write uploads use, with the stat baseline cleared so the poll does not take
the write for an external change. The binary guards (`isBinaryFile`,
`contentDetectedBinary`) that refuse text saves step aside only while a binary
editor owns the file (`binaryCanvasRef`). There is no source toggle; moving to
or from fullscreen saves unsaved changes first, because bytes cannot travel
through the draft. An external change reloads the file and remounts the
editor with the new bytes, unless it has unsaved changes.

## Excalidraw drawings

`.excalidraw` and Obsidian `.excalidraw.md` files open in the Excalidraw
extension (`github.com/openchamber/openchamber-excalidraw`), offered on the
Integrations page (`components/sections/integrations/CatalogExtensionsSection.tsx`).
Without it, where the runtime loads extensions, the file shows its text under
a one-line notice whose Install button opens that card. `isExcalidrawFile`
matches both extensions, and `isMarkdownFile` excludes `.excalidraw.md` so an
Obsidian drawing never takes the markdown preview path; its source view is the
markdown document.

## Moving and renaming

Dropping a row of the sidebar tree on a folder moves the entry there
(`SidebarFilesTree`, drop rules in `components/layout/fileTreeMoveDrag.ts`).
It is the same native drag that attaches a file to the chat, so the drop
target decides what happens. A file row stands for the folder it is in and
the empty space below the tree for the root, as in VS Code. The entry's own
folder, the entry itself and a folder's own subfolders refuse the drop, and a
drop within the click slop of where the drag began stays a click (#2368).
Touch-only devices do not move: the tree scrolls under the finger. A dialog
asks first unless the user turned it off (`confirmFileTreeMove`, Settings >
General). The server refuses a name that already exists in the target and the
tree says so in a toast; nothing is replaced or renamed. VS Code has no file
tree, so nothing moves there.

A move and both rename dialogs (the sidebar tree and `FilesView`'s own tree)
go through `moveWorkspacePath`. It renames through the runtime and then
points the context panel file tabs and `useFilesViewTabsStore` (open, selected
and expanded paths) at the new path with `moveContextFilePaths`. A file tab's
id comes from its path, so the tab is rebuilt in place and stays active. The
two are kept under different folders in a draft waiting for a new space: the
tabs under the draft's folder, the tree's paths under the space it shows.

The open editor keeps unsaved edits through a move (`lib/filePathMoves.ts`).
While the rename request is in flight, `FilesView` refuses saves of paths
under the source, so autosave cannot recreate the file at its old path. When
the move commits, the editor notes it before the tabs move; once the selected
path becomes the new one, it adopts that path instead of re-reading the file,
which would replace the draft. Editors stay keyed by the path the file was
opened under, so the text editor, a canvas or a diagram is not remounted and
keeps its edits and undo history. The draft reset that normally follows a
change of the selected path is skipped for a moved file, and the open-file
poll does not report the old path as a deleted file while the move is in
flight or not yet adopted.

## Uploads

`useFileTreeUpload` owns uploads for every file browser: `FilesView`,
`SidebarFilesTree`, and the phone browser `MobileFilesSurface` (the mobile app
never shows `FilesView`'s tree; it only hosts `FilesView` as the editor). Files
arrive through desktop drag-and-drop or through the system picker, which folder
menus ("Upload Files"), the tree toolbar, and the mobile browser header open.
On mobile the header button uploads into the folder currently on screen. A single upload runs at a time, in batches of three. Existing
names are never replaced silently: they collect into a replace-confirmation
dialog, which is dropped when the workspace or runtime changes. The feature is
present only when the runtime exposes `files.uploadFile`.
