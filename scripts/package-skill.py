"""Package the repository's portable skill; does not install or change user skills."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root = Path(__file__).resolve().parent.parent
output = root / 'dist' / 'scombz-skill.zip'
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for source in sorted((root / 'skills' / 'scombz').rglob('*')):
        if source.is_file():
            archive.write(source, source.relative_to(root / 'skills'))
print(output)
